// Stepped baseline load test - ramps through increasing concurrency levels against a LOCAL
// stack running the fake M-Pesa adapter (see docs/load-tests.md for why: the deployed
// payments service now uses the real Daraja sandbox, and a load test must never hammer a
// real external provider). Finds where latency/error rate starts degrading as load rises,
// feeding docs/capacity-report.md.
//
// Prerequisite: pos/payments/commission/web running locally against a real (not pg-mem)
// Postgres, with NO DARAJA_* env vars set on payments (forces the fake adapter) - see
// docs/load-tests.md for the exact local setup used to produce the run this script backs.
//
// Run: k6 run load-tests/k6-baseline.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.API_BASE || "http://localhost:3000";
const PAYMENTS_BASE = __ENV.PAYMENTS_BASE || "http://localhost:3001";
const COMMISSION_BASE = __ENV.COMMISSION_BASE || "http://localhost:3002";

const posLatency = new Trend("pos_latency", true);

export const options = {
  scenarios: {
    baseline: {
      executor: "ramping-vus",
      exec: "step",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 5 },
        { duration: "30s", target: 5 },
        { duration: "30s", target: 10 },
        { duration: "30s", target: 10 },
        { duration: "30s", target: 20 },
        { duration: "30s", target: 20 },
        { duration: "30s", target: 40 },
        { duration: "30s", target: 40 },
        { duration: "20s", target: 0 },
      ],
    },
  },
  thresholds: {
    // Matches docs/slo-error-budgets.md's pos target - the capacity report notes exactly
    // where in the ramp this stops holding, rather than failing the whole run at the first
    // step that misses it.
    pos_latency: ["p(95)<400"],
  },
};

export function step() {
  let res = http.get(`${BASE}/health`);
  posLatency.add(res.timings.duration);
  check(res, { "pos /health is 200": (r) => r.status === 200 });

  res = http.get(`${PAYMENTS_BASE}/health`);
  check(res, { "payments /health is 200": (r) => r.status === 200 });

  res = http.get(`${COMMISSION_BASE}/health`);
  check(res, { "commission /health is 200": (r) => r.status === 200 });

  sleep(1);
}
