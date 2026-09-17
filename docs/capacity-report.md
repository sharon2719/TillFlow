# Capacity report (G3)

Source data: `docs/load-tests.md` Runs 1–4 (raw output in `evidence/reliability-operations/`).
Run 1 is the only run against the real deployed AWS stack; Runs 2–4 are against a local stack
with the fake M-Pesa adapter, used specifically to find the application code's own ceiling
without also load-testing the real Daraja sandbox or real AWS infra costs.

## Highest sustained RPS

- **Real deployed stack (Run 1):** ~17.6 req/s sustained for 51s (13 concurrent VUs across
  health-check + full business-flow traffic) was enough to push `pos`'s own `/health` p95 to
  462.9ms, over its 400ms SLO target (`docs/slo-error-budgets.md`). This is the number that
  actually matters for capacity planning — it's real infra, real RDS, real ALB path.
- **Local, unconstrained (Runs 2–3):** the application code itself sustained ~49 req/s at 40
  concurrent VUs (Run 2) and briefly ~238 req/s at a 100-VU spike (Run 3) with p95 latency
  never exceeding ~5.5ms. No app-level ceiling was found up to these levels — the local test
  machine ran out of test scope before the code showed any strain.

Read together: **the application code is not the bottleneck.** The gap between "462.9ms p95
at 13 concurrent users in prod" and "5.4ms p95 at 40 concurrent users locally, same code
paths" is almost entirely explained by infra, not logic.

## Bottleneck

`pos` running at `desired_count = 1` (one Fargate task, no spare capacity) is the load-bearing
constraint. `docs/load-tests.md` Run 1 already ruled out CPU saturation (ECS CPUUtilization
peaked at 4.16% during the miss) and ruled out the health-check handler itself doing
meaningful work (`res.json({status:"ok"})`, identical across all four services). The working
hypothesis carried from Run 1 — a single Node event loop serving both `/health` and
`pos`'s DB-writing endpoints (`POST /tenants`, `POST /tills`, `POST /api/v1/sales`) with no
second task to share the load — is unchanged by this pass; it's still unconfirmed by
profiling, but it's now the *only* remaining candidate after Runs 2–3 showed the code itself
holds up fine under far higher concurrency once infra contention is removed from the picture.

## Headroom

At `desired_count = 1`, `pos` has effectively **zero headroom** against its own SLO target —
Run 1 shows the budget getting breached at a concurrency level (13 VUs) that a small business
could plausibly generate from a handful of tills checking out around the same time. This
isn't a code-quality gap: Runs 2–4 show the same code sustaining 40+ concurrent virtual users
locally without breaking a sweat. The headroom problem is entirely an infrastructure decision
(task count / auto scaling), not something a rewrite would fix.

## Cost assumption

The current footprint (`desired_count = 1` for all four services: pos, payments, commission,
web) is the cheapest possible Fargate configuration, chosen deliberately for a training/
capstone AWS account rather than for production-grade redundancy — this trade-off is already
called out in `docs/recovery-drills.md`'s drill 1 from a different angle (a killed task has no
standby to fail over to). Raising just `pos` to `desired_count = 2` — the minimum change that
would remove the single-task contention bottleneck this report identifies — roughly doubles
`pos`'s own Fargate compute cost while leaving the other three services' cost unchanged, since
none of Runs 1–4 point at payments, commission, or web as a bottleneck.

## Caching

TillFlow has no caching layer today — no Redis/ElastiCache, no CDN/edge cache in front of the
API, no in-memory response cache in any service. This report does not include a caching
before/after comparison because no caching change was made or tested in this pass; adding one
wasn't indicated by the data above, since the bottleneck traced to task count/concurrency, not
to repeated expensive reads that a cache would absorb. Recorded here as an open question for a
future pass rather than skipped silently.
