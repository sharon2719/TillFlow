# Release-freeze policy

What a burn-rate alarm firing (`infra/burn-rate-alerts.tf`) actually means for deploys, not
just for who gets paged. Pairs with `docs/slo-error-budgets.md` (the budgets) and
`docs/runbook.md` (per-alarm first response).

## The rule

| Alarm fired | Freeze scope | Who can lift it |
|---|---|---|
| Any `*-fast-burn` (burn rate ≥ 14.4x - would exhaust the 28-day budget in under 2 days) | **Freeze all non-emergency deploys to the affected service** until the alarm clears (`OK`) or the owner explicitly overrides in writing (a commit message or PR description saying why it's safe to proceed anyway). | The service's owner (`docs/ownership.md`) or whoever's on point per `docs/runbook.md`. |
| Any `*-slow-burn` (burn rate ≥ 3x) with no corresponding fast-burn | **No freeze.** Ticket it, fix it on the next normal deploy. | N/A - not a freeze condition. |
| `rds-*`, `alb-elb-5xx`, or any flat-threshold alarm in `infra/monitoring.tf` | **No automatic freeze** - these are infra-health signals, not burn-rate signals. Judgment call per `docs/runbook.md`'s first-response steps for that specific alarm. | N/A. |

A **deploy is exactly what `deployment_circuit_breaker` in `infra/ecs-*.tf` already
protects against post-hoc** (an ECS service auto-rolls back a deployment that fails its own
health checks) - this policy is about *not starting* a new deploy while a budget is already
burning fast, since a bad deploy on top of an active incident compounds the two problems
into one harder-to-diagnose one.

## Why fast-burn specifically, not slow-burn

A fast burn means the current error rate would blow through an entire month's error budget
in under two days if it kept up - deploying something new into that situation risks making
diagnosis (and rollback, if the new deploy is itself implicated) much harder. A slow burn
means the budget is being consumed faster than the target rate, but there's real time to
fix it without stopping normal work - freezing deploys for every slow-burn alarm would
freeze this project constantly, given the proxy-metric nature of these alarms
(`docs/production-readiness.md`) means some slow-burn noise is expected.

## What "freeze" means in practice

Given this project has no separate deploy-approval tooling, the freeze is a **process rule,
not an enforced gate**: don't merge a PR that triggers `deploy-<service>.yml` for the
affected service while its fast-burn alarm is firing, unless the deploy IS the fix. This is
the same trust-based enforcement as everything else in `docs/ownership.md` - a two-person
team without a change-approval board.

## Emergency exception

A deploy that is itself the incident's fix (e.g. a hotfix for the exact bug causing the
burn) is exempt from the freeze it would otherwise trigger - the point of the freeze is to
avoid *compounding* risk, not to block the one action that resolves it.
