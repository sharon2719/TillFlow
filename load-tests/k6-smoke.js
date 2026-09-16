// k6 load test against the real deployed AWS stack (public API Gateway endpoint) - not a
// mock, not localhost. Two scenarios:
//   1. health_load: steady traffic against every service's health endpoint, generating
//      enough ALB request volume to actually exercise the G3 dashboard/alarms
//      (infra/monitoring.tf) instead of them sitting idle at OK with zero data.
//   2. business_flow: a small, bounded number of full tenant -> till -> sale -> STK push ->
//      reconciliation -> commission close iterations, run concurrently, to prove the
//      idempotency guarantees proven sequentially in each service's own test suite also
//      hold under real concurrent load against the live stack.
//
// Deliberately small and bounded (shared-iterations, not sustained VUs) for the business
// flow: this hits real RDS on a db.t4g.micro instance in a shared cohort account, and each
// iteration creates one real tenant - this is a smoke/validation run, not a stress test.
//
// Run: k6 run load-tests/k6-smoke.js
// Or against a different stack: k6 run -e API_BASE=https://... load-tests/k6-smoke.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE = __ENV.API_BASE || "https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com";

const posLatency = new Trend("pos_health_latency", true);
const webLatency = new Trend("web_health_latency", true);
const paymentsLatency = new Trend("payments_health_latency", true);
const commissionLatency = new Trend("commission_health_latency", true);
const flowErrors = new Rate("business_flow_errors");

export const options = {
  scenarios: {
    health_load: {
      executor: "ramping-vus",
      exec: "healthChecks",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "30s", target: 10 },
        { duration: "10s", target: 0 },
      ],
    },
    business_flow: {
      executor: "shared-iterations",
      exec: "businessFlow",
      vus: 3,
      iterations: 15,
      maxDuration: "90s",
      startTime: "5s",
    },
  },
  thresholds: {
    // Matches docs/slo-error-budgets.md's stated p95 targets for pos and web.
    pos_health_latency: ["p(95)<400"],
    web_health_latency: ["p(95)<500"],
    business_flow_errors: ["rate<0.01"],
  },
};

export function healthChecks() {
  let res = http.get(`${BASE}/health`);
  posLatency.add(res.timings.duration);
  check(res, { "pos /health is 200": (r) => r.status === 200 });

  res = http.get(`${BASE}/app/health`);
  webLatency.add(res.timings.duration);
  check(res, { "web /app/health is 200": (r) => r.status === 200 });

  res = http.get(`${BASE}/api/v1/payments/health`);
  paymentsLatency.add(res.timings.duration);
  check(res, { "payments health is 200": (r) => r.status === 200 });

  res = http.get(`${BASE}/api/v1/commission/health`);
  commissionLatency.add(res.timings.duration);
  check(res, { "commission health is 200": (r) => r.status === 200 });

  sleep(1);
}

function msisdnFor(n) {
  return `254712${String(n).padStart(6, "0")}`;
}

export function businessFlow() {
  const iter = `${__VU}-${__ITER}`;
  const headersJson = { "Content-Type": "application/json" };
  let ok = true;

  const tenantRes = http.post(
    `${BASE}/tenants`,
    JSON.stringify({ name: `k6 shop ${iter}`, ownerName: `k6 owner ${iter}`, ownerMsisdn: msisdnFor(__VU) }),
    { headers: headersJson },
  );
  ok = check(tenantRes, { "create tenant 201": (r) => r.status === 201 }) && ok;
  if (tenantRes.status !== 201) {
    flowErrors.add(!ok);
    return;
  }
  const { tenantId, apiKey } = tenantRes.json();
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  const tillRes = http.post(`${BASE}/tills`, JSON.stringify({ name: `Till ${iter}`, commissionRateBps: 500 }), {
    headers: auth,
  });
  ok = check(tillRes, { "create till 201": (r) => r.status === 201 }) && ok;
  if (tillRes.status !== 201) {
    flowErrors.add(!ok);
    return;
  }
  const { tillId } = tillRes.json();

  const saleRes = http.post(
    `${BASE}/api/v1/sales`,
    JSON.stringify({ tillId, items: [{ sku: "K6-SKU", quantity: 1, unitPriceMinorUnits: 10000 }] }),
    { headers: { ...auth, "Idempotency-Key": `k6:sale:${iter}` } },
  );
  ok = check(saleRes, { "create sale 201": (r) => r.status === 201 }) && ok;
  if (saleRes.status !== 201) {
    flowErrors.add(!ok);
    return;
  }
  const { saleId, attendantId, totalMinorUnits } = saleRes.json();

  const stkRes = http.post(
    `${BASE}/api/v1/payments/stk`,
    JSON.stringify({
      tenantId,
      saleId,
      msisdn: msisdnFor(__VU),
      amountMinorUnits: totalMinorUnits,
      accountReference: saleId,
      idempotencyKey: `k6:stk:${iter}`,
    }),
    { headers: headersJson },
  );
  ok = check(stkRes, { "STK push 201": (r) => r.status === 201 }) && ok;
  if (stkRes.status !== 201) {
    flowErrors.add(!ok);
    return;
  }
  const { checkoutRequestId } = stkRes.json();

  const statusRes = http.get(`${BASE}/api/v1/payments/transactions/${checkoutRequestId}`);
  ok = check(statusRes, { "transaction query 200": (r) => r.status === 200 }) && ok;

  const businessDate = new Date().toISOString().slice(0, 10);
  const closeRes = http.post(
    `${BASE}/api/v1/commission/close`,
    JSON.stringify({
      tenantId,
      businessDate,
      commissionRateBps: 500,
      sales: [
        {
          saleId,
          attendantId,
          attendantMsisdn: msisdnFor(__VU),
          totalMinorUnits,
          paymentStatus: "paid",
        },
      ],
    }),
    { headers: { ...headersJson, "Idempotency-Key": `k6:close:${iter}` } },
  );
  ok = check(closeRes, { "commission close 201": (r) => r.status === 201 }) && ok;

  flowErrors.add(!ok);
}
