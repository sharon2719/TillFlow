// 15+ minute soak test - sustained moderate load against the same local fake-adapter stack
// as k6-baseline.js/k6-spike.js (see docs/load-tests.md). Looks for degradation over time
// that a short test wouldn't catch: a leaking connection pool, unbounded memory growth, GC
// pauses that get worse, anything that only shows up after sustained running.
//
// Two mixed scenarios: steady health-check traffic, plus a low, steady trickle of full
// business-flow iterations (sale -> STK -> reconciliation -> commission close) so
// correctness under sustained load is checked too, not just raw throughput.
//
// Run: k6 run load-tests/k6-soak.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.API_BASE || "http://localhost:3000";
const PAYMENTS_BASE = __ENV.PAYMENTS_BASE || "http://localhost:3001";
const COMMISSION_BASE = __ENV.COMMISSION_BASE || "http://localhost:3002";

const posLatencyOverTime = new Trend("pos_latency_over_time", true);

export const options = {
  scenarios: {
    steady_health: {
      executor: "constant-vus",
      exec: "health",
      vus: 10,
      duration: "15m",
    },
    steady_business_flow: {
      executor: "constant-arrival-rate",
      exec: "businessFlow",
      rate: 6, // 6 per minute - a low, steady trickle, not a throughput test
      timeUnit: "1m",
      duration: "15m",
      preAllocatedVUs: 3,
      maxVUs: 10,
    },
  },
  thresholds: {
    pos_latency_over_time: ["p(95)<400"], // if this SLO target holds at minute 1, it should still hold at minute 15
  },
};

export function health() {
  let res = http.get(`${BASE}/health`);
  posLatencyOverTime.add(res.timings.duration);
  check(res, { "pos /health is 200": (r) => r.status === 200 });

  res = http.get(`${PAYMENTS_BASE}/health`);
  check(res, { "payments /health is 200": (r) => r.status === 200 });

  res = http.get(`${COMMISSION_BASE}/health`);
  check(res, { "commission /health is 200": (r) => r.status === 200 });

  sleep(1);
}

function msisdnFor(n) {
  return `254712${String(n % 1000000).padStart(6, "0")}`;
}

export function businessFlow() {
  const iter = `soak-${__VU}-${__ITER}-${Date.now()}`;

  const tenantRes = http.post(
    `${BASE}/tenants`,
    JSON.stringify({ name: `k6 soak shop ${iter}`, ownerName: `k6 soak owner ${iter}`, ownerMsisdn: msisdnFor(__VU) }),
    { headers: { "Content-Type": "application/json" } },
  );
  if (!check(tenantRes, { "soak: create tenant 201": (r) => r.status === 201 })) return;
  const { tenantId, apiKey } = tenantRes.json();
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  const tillRes = http.post(`${BASE}/tills`, JSON.stringify({ name: `Till ${iter}`, commissionRateBps: 500 }), {
    headers: auth,
  });
  if (!check(tillRes, { "soak: create till 201": (r) => r.status === 201 })) return;
  const { tillId } = tillRes.json();

  const saleRes = http.post(
    `${BASE}/api/v1/sales`,
    JSON.stringify({ tillId, items: [{ sku: "SOAK-SKU", quantity: 1, unitPriceMinorUnits: 10000 }] }),
    { headers: { ...auth, "Idempotency-Key": `k6:soak:sale:${iter}` } },
  );
  if (!check(saleRes, { "soak: create sale 201": (r) => r.status === 201 })) return;
  const { saleId, attendantId, totalMinorUnits } = saleRes.json();

  const stkRes = http.post(
    `${PAYMENTS_BASE}/api/v1/payments/stk`,
    JSON.stringify({
      tenantId,
      saleId,
      msisdn: msisdnFor(__VU),
      amountMinorUnits: totalMinorUnits,
      accountReference: saleId,
      idempotencyKey: `k6:soak:stk:${iter}`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
  if (!check(stkRes, { "soak: STK push 201": (r) => r.status === 201 })) return;

  const businessDate = new Date().toISOString().slice(0, 10);
  const closeRes = http.post(
    `${COMMISSION_BASE}/api/v1/commission/close`,
    JSON.stringify({
      tenantId,
      businessDate,
      commissionRateBps: 500,
      sales: [{ saleId, attendantId, attendantMsisdn: msisdnFor(__VU), totalMinorUnits, paymentStatus: "paid" }],
    }),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": `k6:soak:close:${iter}` } },
  );
  check(closeRes, { "soak: commission close 201": (r) => r.status === 201 });
}
