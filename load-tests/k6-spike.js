// Spike test - a sudden jump from light to heavy concurrency and back, against the same
// local fake-adapter stack as k6-baseline.js (see docs/load-tests.md). Tests recovery
// behavior: does error rate/latency return to normal once the spike passes, or does it
// stay degraded (a sign of exhausted connections/resources that don't recover on their
// own)?
//
// Run: k6 run load-tests/k6-spike.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE = __ENV.API_BASE || "http://localhost:3000";
const PAYMENTS_BASE = __ENV.PAYMENTS_BASE || "http://localhost:3001";
const COMMISSION_BASE = __ENV.COMMISSION_BASE || "http://localhost:3002";

const errors = new Rate("errors");

export const options = {
  scenarios: {
    spike: {
      executor: "ramping-vus",
      exec: "hit",
      startVUs: 2,
      stages: [
        { duration: "20s", target: 2 }, // baseline before the spike
        { duration: "5s", target: 100 }, // the spike itself - fast ramp
        { duration: "30s", target: 100 }, // hold at spike level
        { duration: "5s", target: 2 }, // fast drop
        { duration: "30s", target: 2 }, // recovery window - does error rate settle back down?
      ],
    },
  },
  thresholds: {
    errors: ["rate<0.05"], // some elevated error rate during the spike itself is expected; >5% overall is not
  },
};

export function hit() {
  for (const base of [BASE, PAYMENTS_BASE, COMMISSION_BASE]) {
    const res = http.get(`${base}/health`, { timeout: "5s" });
    const ok = check(res, { "200 during spike/recovery": (r) => r.status === 200 });
    errors.add(!ok);
  }
  sleep(0.5);
}
