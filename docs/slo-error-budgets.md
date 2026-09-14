# SLIs, SLOs and error budgets

Draft — starter targets from the capstone brief. Budget = eligible events × (1 − target),
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

_(no changes yet)_
