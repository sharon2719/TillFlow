# SLIs, SLOs and error budgets

Finalized before G3, per the brief's own rule (see "Changing targets" below for the one
review that happened against real data before locking these in). Budget = eligible events ×
(1 − target),
over a rolling 28-day window unless noted. Invalid requests and genuine business declines
(e.g. insufficient till float) are excluded from the denominator; a Daraja or infrastructure
outage that causes a user-visible failure still counts against the budget even though the
root cause is external.

| Service | SLI (numerator / denominator) | Target | 28-day budget | User outcome represented |
|---|---|---|---|---|
| Web | Eligible page/API-shell loads that succeed, p95 < 500ms / all eligible loads | ≥ 99.9% | 0.1% (40m 19s) | The app shell is usable when someone opens it. |
| POS API | Valid sale writes accepted exactly once, p95 < 400ms / all valid sale write attempts | ≥ 99.9% | 0.1% (40m 19s) | An attendant's recorded sale is never lost or duplicated. |
| Payments API | Valid STK/B2C commands accepted and callbacks processed within 60s / all valid payment commands | ≥ 99.5% | 0.5% (3h 21m 36s) | A customer's till payment or an attendant's payout resolves to a known state quickly. |
| Commission | Eligible payouts reaching a terminal state by 06:30 EAT / all eligible daily payouts; duplicate disbursement = 0 always | ≥ 99.0% (0 duplicates, no exception) | 1% events, 0.28 late runs per 28-day window | An attendant is paid, once, on time, every working day. |

## Exclusions
- Requests that fail input validation (malformed body, missing tenant scope) are excluded
  from both numerator and denominator — they never represent a real user journey failing.
- A Daraja sandbox outage, an RDS failover, or a Redis eviction storm still count against
  the relevant service's budget, because the user-facing journey still failed even though
  TillFlow's own code didn't cause it.
- The Commission "duplicate disbursement = 0" clause has no budget at all — it's a hard
  invariant, not a rate; any duplicate is a G2/G4 blocking defect, not a burn-rate event.

## Changing targets
Targets may only change before final benchmarking (before G3), and only with a written
rationale appended below this line, per the brief's rule.

**2026-09-17 — reviewed against real data, targets kept as-is.** `docs/load-tests.md`'s k6
run showed `pos` missing its own 400ms p95 target under load (462.9ms), with CPU nowhere
near saturated - the working hypothesis is event-loop contention from `desired_count = 1`
giving zero spare capacity (`docs/production-readiness.md`), not that 400ms is
unrealistic for what `pos` actually does. Decided not to loosen the target to make a real
capacity gap disappear on paper - the target stays at 400ms as the actual promise being
made, and the accepted risk of missing it under load stays visible in
`docs/production-readiness.md` instead of being hidden by a rewritten SLO. Commission's
06:30 EAT deadline is unchanged and now has a real mechanism behind it: `infra/async.tf`'s
EventBridge schedule fires at 05:00 EAT, a 1.5h buffer. Web and Payments targets are
unchanged - no data has come in that challenges either.
