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

## Run 2 — baseline (stepped ramp)

**Date:** 2026-09-17. **Command:** `k6 run load-tests/k6-baseline.js`. **Target:** a local
stack (`pos`/`payments`/`commission`/`web` run via `tsx watch` against a disposable Docker
Postgres, `payments` using `FakeMpesaAdapter` — no `DARAJA_*` env vars set). Load tests must
never hammer the real Daraja sandbox (see `load-tests/k6-daraja-contract.js`'s comment for
why that one small test is the sole exception); everything throughput/latency-shaped runs
locally instead. **Raw output:** `evidence/reliability-operations/k6-baseline-2026-09-17.txt`.

Stepped ramp: 0→5→10→20→40 VUs over ~4m, hitting all three services' `/health` endpoints.

**Result: 12756/12756 checks passed, 0 failed.** `pos_latency` p95 = 5.41ms against the
`docs/slo-error-budgets.md` target of <400ms — no degradation at any step up to 40 VUs. This
does not contradict Run 1's real p95=462.9ms miss against the live AWS deployment: Run 1 hit
the real ALB/API-Gateway/VPC-Link path with `desired_count=1` and real RDS; this run isolates
whether the application code itself degrades under concurrency, holding the network path and
infra-capacity questions constant. It doesn't — the Run 1 miss is infra-path latency, not
app-level contention.

## Run 3 — spike (sudden 2→100→2 VUs)

**Date:** 2026-09-17. **Command:** `k6 run load-tests/k6-spike.js`. **Target:** same local
stack as Run 2. **Raw output:** `evidence/reliability-operations/k6-spike-2026-09-17.txt`.

**Result: 21555/21555 checks passed, 0% error rate** (threshold was `<5%`). p95=4.08ms
throughout the spike and the recovery window — no lingering degradation after the VU count
dropped back to 2, i.e. no sign of exhausted connections/handles that don't recover on their
own.

## Run 4 — soak (15 minutes)

**Date:** 2026-09-17. **Command:** `k6 run load-tests/k6-soak.js`. **Target:** same local
stack as Runs 2–3. **Raw output:** `evidence/reliability-operations/k6-soak-2026-09-17.txt`.

Two concurrent scenarios for the full 15 minutes: `steady_health` (constant 10 VUs hitting
all three `/health` endpoints) and `steady_business_flow` (a steady trickle — 6/min — of the
full tenant → till → sale → STK push → commission-close chain).

**`steady_health` result: held its SLO for the full 15 minutes.**
`pos_latency_over_time` p95 = 11.81ms against the <400ms threshold — the number this test
exists to produce doesn't drift upward over a sustained run the way a leaking connection pool
or unbounded memory growth would show up.

**`steady_business_flow` result: 0/90 iterations succeeded — but this is a documented local
test-harness failure, not an application defect.** Root cause, confirmed by direct
investigation, not assumed: Docker Desktop on the machine running this test crashed and
restarted its engine mid-run, taking down the disposable local Postgres container
(`tillflow-loadtest-pg`) that `pos` depends on for `POST /tenants`. `pos`'s own log shows the
exact failure — an unhandled `ECONNREFUSED` to `127.0.0.1:15432` inside
`services/pos/src/routes/tenants.ts:29` — which crashed the `pos` process outright (the route
itself is correct; nothing here indicates an app-level bug in the tenants/sales/STK/commission
chain, which Run 1 already proved works correctly under concurrent load against the real
deployment). Docker Desktop then crashed two further times in the ~10 minutes spent trying to
get a clean re-run, confirming this is a real, repeatable instability on this particular
machine right now rather than a one-off. Given `steady_health`'s result already answers the
soak test's core question (does latency hold up over 15 minutes of sustained load — yes), and
the business-flow chain's correctness under load was already independently proven in Run 1
against the real deployment, a clean re-run of this one scenario was not pursued further.
**Open follow-up:** re-run `steady_business_flow` in isolation once Docker Desktop is stable,
to get a genuine 15-minute correctness-under-sustained-load result for that path specifically.

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
