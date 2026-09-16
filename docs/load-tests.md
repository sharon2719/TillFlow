# Load tests (G3/G4)

Real k6 runs against the live AWS stack (`load-tests/k6-smoke.js`), not localhost and not
against pg-mem. Raw output for each run lives in `evidence/reliability-operations/`.

## Run 1 — smoke + SLO threshold check

**Date:** 2026-09-16. **Command:** `k6 run load-tests/k6-smoke.js`. **Target:**
`https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com` (public API Gateway endpoint).
**Raw output:** `evidence/reliability-operations/k6-smoke-2026-09-16.txt`.

Two scenarios, run concurrently over ~51s:
- `health_load` — ramping to 10 VUs hitting all four services' health endpoints.
- `business_flow` — 15 shared iterations across 3 VUs, each running the full
  tenant → till → sale → STK push → reconciliation query → commission close chain against
  the real deployed pos/payments/commission services (the same chain proven manually
  end-to-end earlier, now under concurrent load instead of one request at a time).

**Functional result: 902/902 checks passed, 0 failed, 0 HTTP errors.** All 15 concurrent
business-flow iterations completed successfully - idempotency and the tenant-auth
boundary held under real concurrent load, not just the sequential proof done by hand and in
each service's own test suite.

**SLO threshold result: `pos` missed its own target.**

| Metric | Threshold (from docs/slo-error-budgets.md) | Result |
|---|---|---|
| `web_health_latency` p95 | < 500ms | 345.42ms — **pass** |
| `pos_health_latency` p95 | < 400ms | 462.9ms — **fail** |

**What's *not* the cause:** ECS CPUUtilization for `devops-g5-pos` peaked at 4.16% during
the test window (`aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name
CPUUtilization`) - nowhere near saturated. `services/pos/src/health.ts`'s handler is a bare
`res.json({status:"ok"})`, identical in shape to web/payments/commission's - the SLO miss
isn't the health check itself doing more work.

**Working hypothesis, not yet confirmed:** `pos` is the only service in this test that also
serves `business_flow`'s three DB-writing endpoints (`POST /tenants`, `POST /tills`,
`POST /api/v1/sales`) in the same window `health_load` is hitting its `/health` endpoint -
same single Node event loop, same single Fargate task (`desired_count = 1`, no spare
capacity - the same gap `docs/recovery-drills.md`'s drill 1 already flagged from a different
angle). A synchronous API-key hash (`services/pos/src/auth.ts`'s `hashApiKey`) or an awaited
RDS round-trip briefly blocking the event loop would show up exactly like this: a p95 tail
effect with CPU still near-idle, not a sustained average slowdown. Not confirmed with
profiling in this pass - tracked as a follow-up in `docs/production-readiness.md`.

**Why this matters beyond one failed threshold:** this is now the *second* independent
piece of evidence (after the G4 task-kill drill) that `desired_count = 1` with no spare
capacity is a real, measurable constraint on pos specifically, not a hypothetical concern.

## Follow-ups

- Re-run with per-request server-side timing (X-Ray trace segments already exist via the
  ADOT sidecar - pull the actual server-side span duration instead of only the client-observed
  round trip, to separate "pos itself was slow" from "the API Gateway/VPC Link/ALB path added
  latency", which is the same ~200ms floor visible on every service's minimum latency here).
- If confirmed as event-loop contention: consider whether `hashApiKey`'s use of
  `createHash` (synchronous, but cheap for SHA-256 over a short string) is actually the
  culprit, or whether it's purely RDS round-trip time under concurrent writes.
- Re-run at a higher, sustained load once `desired_count` capacity questions from
  `docs/recovery-drills.md` are decided, to see whether the same p95 miss reproduces or was
  a one-off tail effect from this smoke-sized run.
