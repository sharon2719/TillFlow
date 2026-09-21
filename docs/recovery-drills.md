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

## Drill 2 — rehearse the runbook end-to-end (not just read it)

**Date:** 2026-09-17. **Owner:** sharon2719.

**Objective:** `docs/runbook.md` had never been walked through against the real stack -
only two of its claims had ever been exercised (both via drill 1, indirectly). Every
documented "first response" command and every referenced link was run for real, and the
alert-delivery path itself was test-fired, not just assumed to work because the Terraform
looks right.

**What was rehearsed and confirmed accurate, command by command:**

| Runbook claim | Rehearsed as | Result |
|---|---|---|
| `terraform output dashboard_url` / `api_endpoint` resolve | ran both | both resolve to real, live resources |
| `aws logs tail /devops-g5/pos --since 15m` | ran against the live log group | real request logs returned, including the external probe's own traffic |
| `/aws/lambda/devops-g5-external-probe` logs show pass/fail | tailed the group | real "Probe succeeded" entries, one per minute, matching `infra/external-probe.tf`'s schedule |
| `curl https://<api endpoint>/health` | ran it | `200 {"status":"ok"}` |
| Grafana reachable at `<api endpoint>/grafana/...` | `curl .../grafana/api/health` | `200` |
| `aws ecs describe-services --cluster devops-g5 --services devops-g5-<service>` | ran for pos and commission | both correct, `runningCount == desiredCount` |
| Dashboard has a "5xx count by service" panel with an ALB-wide line | fetched the real dashboard body (`aws cloudwatch get-dashboard`) and inspected its widgets | panel exists with exactly 4 per-service lines plus `HTTPCode_ELB_5XX_Count` labeled "ALB itself (e.g. no healthy target)" - matches the `alb-elb-5xx` procedure's description exactly |
| Email is a working SNS subscription, Slack is a real (if inert) Lambda subscription | `aws sns list-subscriptions-by-topic` | both subscriptions confirmed (not `PendingConfirmation`) |

Everything above matched the documentation. The one thing that didn't:

**A real gap found, not assumed: two live test-fires of real CloudWatch alarms produced no
observable SNS delivery at all.** Using `aws cloudwatch set-alarm-state` (AWS's own
documented way to test alarm actions without waiting for a real threshold breach),
`devops-g5-pos-5xx` and, separately, `devops-g5-pos-unhealthy` were each forced from `OK` to
`ALARM` and back. `describe-alarm-history` confirms both were genuine, timestamped state
transitions, and both alarms have `ActionsEnabled: true` with `AlarmActions`/`OKActions`
correctly pointing at `devops-g5-alerts`. But across a 20+ minute window spanning both
test-fires:
- `AWS/SNS` `NumberOfMessagesPublished` for the topic: zero datapoints.
- `AWS/Lambda` `Invocations` for `devops-g5-slack-notifier`: zero datapoints.
- `/aws/lambda/devops-g5-slack-notifier` logs: empty.

Static configuration review (topic policy, the Lambda's resource policy, `AlarmActions`
ARNs) found nothing wrong - which is exactly why this only surfaced by actually rehearsing
the path instead of reading the Terraform. **Not yet root-caused**: it may be that
`SetAlarmState`-driven transitions behave differently than a real threshold breach for this
account/topic combination, or a genuine delivery gap that would affect real alerts too - the
difference matters and isn't resolved yet.

**Conclusion:** the runbook's investigative commands and links are all accurate and usable
during a real incident - that part of the rehearsal passed outright. Whether an alarm
reaching `ALARM` actually reaches a human being is now an open, confirmed-uncertain
question, not a confirmed-working one as the runbook currently implies. That's a more
important finding than any of the passing checks above.

**Follow-ups (tracked in `docs/production-readiness.md`):**
- Confirm with whoever owns `tillflow4@gmail.com` whether either test-fire's email actually
  arrived - the one check this drill couldn't perform itself.
- If it didn't: root-cause why a `CloudWatch Alarm -> SNS Topic -> {email, Lambda}` path with
  correct-looking IAM/topic policy doesn't deliver - candidates include SNS's own delivery
  retry/backoff behavior, a mismatch between the account's actual default region and where
  the alarm/topic/subscription each believe they are, or a still-undiscovered policy gap.
- Once fixed, re-run this exact test-fire and confirm a real SNS publish + Lambda invocation
  this time, then update this drill's entry with the corrected result rather than opening a
  new one.
