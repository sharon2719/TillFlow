# Recovery drills (G4)

Documented failure/recovery exercises against the real AWS stack - what was done, what
actually happened (timestamps from AWS, not estimates), and what it changed about how the
system is understood. Not a simulation or a tabletop exercise; every drill here was run
against `devops-g5` in `eu-west-1`.

## Drill 1 — kill the only running `pos` task

**Date:** 2026-09-16. **Owner:** sharon2719.

**Objective:** with `desired_count = 1` and no extra capacity on any service (see
`docs/production-readiness.md`), does ECS actually replace a killed task on its own, and do
the alarms added in G3 (`infra/monitoring.tf`) catch the gap while it's happening?

**Method:** captured the baseline (running task ARN, all `pos` alarms `OK`, `/health` = 200
through the public API Gateway endpoint), then ran
`aws ecs stop-task --cluster devops-g5 --task <arn> --reason "G4 recovery drill"` and polled
`runningCount`, the public `/health` endpoint, and `devops-g5-pos-unhealthy`'s alarm state
every 5 seconds until recovery.

**Timeline (from ECS service events, UTC):**

| Time | Event |
|---|---|
| 12:51:59 | `stop-task` issued |
| 12:52:11 | old task deregistered from the ALB target group, connections draining |
| 12:52:12 | ECS starts a replacement task |
| ~12:52:20 | public `/health` observed returning `503` (no healthy target) |
| 12:52:39 | new task registers as healthy in the target group |
| ~12:52:40 | public `/health` observed returning `200` again |
| 12:52:48 | service reaches steady state |

**Real user-facing outage: ~28–40 seconds**, entirely without any human intervention - ECS's
own service scheduler replaced the task unprompted.

**What the alarms did:** nothing. `devops-g5-pos-unhealthy` never left `OK`
(`describe-alarm-history` shows no state-transition events in the window at all) and
`devops-g5-pos-5xx` never fired either. Two separate reasons, both real gaps, not the same
gap twice:

1. **The unhealthy-host alarm's 2-minute evaluation window (`infra/monitoring.tf`) is longer
   than the outage it was supposed to catch.** That window was deliberately set so a routine
   rolling deploy - which causes this exact same brief gap, every time, by design, since
   `desired_count = 1` gives zero spare capacity during any deployment - doesn't page anyone.
   The drill proves the tradeoff is real in both directions: it also means a genuine ~30s
   failure produces zero alert, identical to a routine deploy from the alarm's point of view.
2. **The 5xx alarm only watches `HTTPCode_Target_5XX_Count`**, which counts responses a
   target actually returned. The `503` returned during this drill came from the ALB itself
   (no healthy target to route to), which is `HTTPCode_ELB_5XX_Count` instead - confirmed via
   `aws cloudwatch get-metric-statistics`, which shows exactly one ELB-level 5xx at
   `12:52:00Z` and zero target-level 5xx for the same window. Nothing in `infra/monitoring.tf`
   alarms on the ELB-level metric today.

**Conclusion:** the self-healing worked exactly as ECS's design promises, with no manual
step and no data loss (no in-flight sale/payment was recorded during the gap - traffic
during this drill was just the health-check polling above). But G3's alerting has a real,
now-confirmed blind spot for exactly the class of failure fast enough to resolve on its own:
it will not tell anyone this happened. For a failure that *doesn't* self-resolve in under
two minutes, the same alarms would fire correctly - only the fast, transient case is silent.

**Follow-ups (tracked in `docs/production-readiness.md`, not fixed in this drill):**
- Add an alarm on `HTTPCode_ELB_5XX_Count` (load-balancer-wide) alongside the existing
  per-target-group 5xx alarms, so a "no healthy target" event is visible even when it
  resolves inside the unhealthy-host alarm's window.
- Decide, with the SLO targets in mind, whether a ~30s gap on every deploy (not just
  failures) is acceptable against pos's 99.9% / 40m19s monthly budget - `desired_count = 2`
  would remove the gap entirely at roughly double the Fargate cost per service.
- If the 2-minute window stays as-is (deliberately, to avoid deploy-noise pages), document
  that choice explicitly as "we accept not being paged for sub-2-minute self-healing events"
  rather than leaving it as an implicit side effect nobody decided on purpose.
