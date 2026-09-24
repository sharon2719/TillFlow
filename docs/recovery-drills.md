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
the path instead of reading the Terraform.

**Follow-up (2026-09-18) narrowed this from "unconfirmed" to a specific, isolated finding.**
A direct `aws sns publish` straight to `devops-g5-alerts` (bypassing CloudWatch entirely)
invoked `devops-g5-slack-notifier` in under a second, logged correctly, and produced a real
`NumberOfMessagesPublished` datapoint - so SNS's own delivery to its Lambda subscriber is
proven working. A third `set-alarm-state` test-fire, checked within seconds and confirmed to
still be sitting in a genuine `ALARM` state (not auto-corrected away this time, ruling out a
race with the alarm's own 5-minute evaluation cycle), still produced zero
`NumberOfMessagesPublished` and zero Lambda invocation. **Root cause is now isolated, not
just observed:** SNS delivery itself works; a CloudWatch alarm reaching `ALARM` on this
account does not result in CloudWatch actually calling `sns:Publish` at all, despite
`ActionsEnabled: true` and a correctly-configured `AlarmActions`. This is a narrower, harder
claim than "alerting might not work" - it points specifically at CloudWatch's own
action-invocation step, not at SNS, Lambda, or any policy this repo controls. Not something
diagnosable further from the CLI surface available here; the next step is checking whether
this AWS Organizations account has a guardrail affecting cross-service CloudWatch actions,
or filing an AWS Support case.

**Conclusion (superseded by the 2026-09-21 follow-up below - kept for the real timeline, not
deleted):** the runbook's investigative commands and links are all accurate and usable
during a real incident - that part of the rehearsal passed outright. Whether an alarm
reaching `ALARM` actually reached a human being was, at this point in the drill, a
**confirmed gap**, not the confirmed-working path the runbook implied before this drill -
the 2026-09-18 follow-up had pinned down exactly which link in the chain was broken, but not
yet fixed it.

**Follow-up (2026-09-21): fixed for real, root cause found and confirmed via live diagnostics,
not guessed.** Confirmed with the owner of `tillflow4@gmail.com` that neither test-fire's
email had arrived either - both channels were downstream of the same broken step, as
suspected. Root-caused via two controlled live experiments (temporary alarms/topics, all
torn down after):

1. **CloudWatch's native `AlarmActions` -> SNS mechanism**: confirmed NOT a KMS/encryption
   issue - a brand-new test alarm pointed at a brand-new *unencrypted* test topic still
   produced zero publish. This specific mechanism's failure remains genuinely unexplained
   and is worked around, not fixed (see below) - still worth an AWS Support case if anyone
   wants the real answer.
2. **The actual fix**: built `infra/alarm-eventbridge-bridge.tf`, an `aws_cloudwatch_event_rule`
   that catches "CloudWatch Alarm State Change" events (a completely independent EventBridge
   mechanism, not an alarm's own `AlarmActions`) and republishes them to the same SNS topic
   in the same JSON shape the Slack Lambda already expects - zero Lambda or email changes
   needed. This path had its own, *different* KMS problem: a live isolation test (identical
   EventBridge target against a fresh encrypted topic vs. a fresh unencrypted one) proved
   encryption specifically blocked EventBridge's publish, while the unencrypted case
   delivered on the first try. Fixed by removing KMS encryption from `aws_sns_topic.alerts`
   entirely (`monitoring.tf` - the topic only ever carried alarm text, never customer data,
   so this isn't a new risk).
3. **Verified end to end for real**, not just component-by-component: fired
   `devops-g5-pos-5xx` via `set-alarm-state` (a genuine state transition, not a direct
   publish/invoke), confirmed the Lambda ran within 3 seconds via the real
  CloudWatch -> EventBridge -> SNS -> Lambda path, and the owner visually confirmed the
  message arrived in Slack. The captured Slack notification is committed at
  [evidence/group-5-slack-alert.png](../evidence/group-5-slack-alert.png).

**Second follow-up, same day (2026-09-21): the claim that CloudWatch's native mechanism
"doesn't work at all" was itself wrong, corrected by more live evidence, not by guessing.**
While debugging an unrelated problem (Slack receiving duplicate notifications per alarm
transition - see the dedup entry in `docs/scar-log.md`), the two duplicate SNS messages
were captured and compared directly. One was the EventBridge bridge's minimal transformed
JSON, as expected - the other was CloudWatch's own **native**, full-detail alarm
notification format (`AlarmArn`, `Trigger`, `OKActions`, etc.), which every earlier test in
this drill had concluded never arrives. It does arrive - just unreliably, with enough delay
that every short, deliberate test window in this drill's earlier rounds (each checked within
seconds to low minutes) happened to miss it. **Corrected claim: CloudWatch's native
`AlarmActions` -> SNS mechanism is not dead, it's unreliable/delayed in a way this drill's
own test methodology couldn't distinguish from "broken" until a real, unplanned duplicate
delivery caught it in the act.** The EventBridge bridge remains the right fix regardless -
it delivers reliably and fast (seconds), which the native path apparently doesn't - but the
earlier "genuinely unexplained, confirmed not working" framing overstated what was actually
shown. Fixed for real this time with a semantic (parsed AlarmName/NewStateValue/
NewStateReason) dedup key in the Slack Lambda, since the two paths' SNS messages are
byte-for-byte different (different shape, different envelope) even when describing the same
real transition - a naive content-hash or MessageId-based dedup (both tried first, both
failed live) can't catch that.

**The runbook and production-readiness docs have been updated to reflect this corrected
understanding**, not the original "doesn't work at all" claim. What's still genuinely
unresolved is *why* the native mechanism is unreliable rather than simply slow by a fixed,
predictable amount - not diagnosable further from the CLI surface available here, still
worth an AWS Support case if anyone wants the real answer.

## Incident 1 — payments crash-looping on a rotated RDS password (not a drill - found live)

**Date:** 2026-09-21. **Found by:** accident, while preparing the backup/restore drill below
- not staged, not planned, a real production-shaped failure caught in the act.

**What happened:** `payments`'s public health check started returning an inconsistent mix of
502/503/504 through the live endpoint. `aws elbv2 describe-target-health` showed the ALB
target as `healthy` - the failure wasn't visible at the load-balancer level at all, only by
actually hitting the endpoint repeatedly. `payments`'s own CloudWatch logs showed the real
cause immediately: `error: password authentication failed for user "tillflow_admin"`
(Postgres code `28P01`), an **uncaught** error that crashed the entire Node process on the
spot (`Node.js v22.11.0` then nothing further in the log).

**Root cause, confirmed not assumed:** `aws secretsmanager describe-secret` on the RDS
master-user secret showed `rotationEnabled: true` and `lastRotated: 2026-09-21T03:09:42+03:00`
- AWS's own managed rotation had changed the database password that morning.
`pos` and `commission` share the same RDS instance and the same rotation, but both had
redeployed since 03:09 (confirmed via their task definition revision numbers and by directly
exercising their real DB-writing endpoints - `POST /tenants` and `POST /api/v1/commission/close`
both worked cleanly), so they'd already picked up the fresh credential as a side effect of
starting up after it changed. `payments` had not been redeployed since before the rotation
(task definition revision `:5`, unchanged) and was still holding the now-invalid password in
memory - every DB-touching request crashed it outright, and ECS's own restart-on-crash
briefly restored `/health` each time until the next DB-touching request crashed it again.
This is a **real crash loop**, not a single outage.

**The fix, and why it's safe:** `aws ecs update-service --cluster devops-g5 --service
devops-g5-payments --force-new-deployment` - the same task definition, no code or config
change, just forces ECS to start a fresh task, which re-resolves the `secrets` block from
Secrets Manager at container start and picks up the current password. Run by sharon2719 at
my request (this exact action is one the AWS session's own tooling classifier blocks me from
running directly). Confirmed fixed within the same minute: `payments`'s actual DB-touching
endpoint (`GET /api/v1/payments/transactions/:id`) returned a correct `200` immediately
after, and 3 consecutive health checks all returned clean `200`s.

**Why this is worse than it looks, and a real gap, not just a fixed incident:** this is
*exactly* the class of failure `docs/recovery-drills.md` drill 2 already found alerting
can't currently catch - `payments` was silently crash-looping in production with no alarm
firing (even setting aside drill 2's separate finding that alarm delivery itself is broken,
nothing here even reached `ALARM` state, since the ALB-level target health looked fine and
`<service>-5xx`/`<service>-unhealthy` are keyed off ALB-visible signals, not "the container
crashed and ECS quietly restarted it faster than the alarm's evaluation window"). This
combines with drill 1's finding (self-healing that's invisible to alerting) and drill 2's
finding (alerting that doesn't reach anyone even when it does fire) into a single, concrete,
now-proven scenario: **a real credential rotation could have degraded payments for hours
with nobody told**, caught here only because this session happened to be poking at the
endpoint for an unrelated reason.

**Follow-ups (tracked in `docs/production-readiness.md`):**
- `pos` and `commission` were saved by coincidental redeploy timing, not by design - the same
  rotation landing when none of the three services had redeployed recently would have taken
  all three down at once. Needs an actual fix, not a lucky timing observation: either disable
  automatic master-password rotation for this stack (accepting the security trade-off,
  documented rather than silent) or add a mechanism that restarts all three DB-dependent
  services when the secret rotates (e.g. an EventBridge rule on the rotation event triggering
  `force-new-deployment` on each service).
- **Fixed same-day, not just logged**: `/health` on every service was a bare
  `res.json({status:"ok"})` specifically so it never depended on the DB - reasonable for
  distinguishing "the process is alive" from "a slow query", but it meant a fully
  DB-broken service could report itself healthy indefinitely. `services/pos/src/health.ts`
  had a `/ready` route already, but it was the same bare stub with its own
  `TODO(G2): wire real checks` unaddressed - exactly the case this incident is. All three
  DB-dependent services (`pos`, `payments`, `commission`) now have a real `/ready` that
  round-trips the DB with `SELECT 1` and returns `503` on failure (new tests cover both the
  healthy and broken-DB cases). **Still open**: the restart-on-rotation mechanism itself (the
  bullet above) - `/ready` reporting unhealthy only helps once something acts on it, and
  today nothing automatically redeploys a service whose target goes unhealthy this way.
- **Applying the ALB side of this fix ahead of the code caused a real, multi-act
  self-inflicted incident the same day, including a previously-undiscovered Terraform gap**
  (task definitions silently defaulting to a nonexistent `:bootstrap` image tag) - see
  `docs/scar-log.md`'s "A single terraform apply chained into three compounding
  self-inflicted incidents" for the full account, and `docs/production-readiness.md` for the
  still-open structural gap it exposed. **Current live state, confirmed recovered**: all four
  public endpoints return `200`; `pos`'s target group correctly health-checks `/ready` (its
  route pre-dates this fix, deployed and healthy on task definition revision `:14`);
  `payments`'s and `commission`'s target groups are back on `/health` in the actual
  `infra/alb.tf` source (not just a temporary out-of-band fix) until their `/ready` code is
  merged and deployed; `commission`'s SQS worker is confirmed live (`"commission
  scheduled-close worker started"` in its own logs, task definition revision `:6`).

## Drill 3 — restore a real snapshot, verify RTO

**Date:** 2026-09-21. **Owner:** sharon2719.

**Objective:** `evidence/platform-delivery/` had no backup/restore evidence at all - automated
backups were configured (`backup_retention_period = 7`, `infra/rds.tf`) but never proven to
actually produce something restorable, and no RTO number existed anywhere.

**Method:** a real manual snapshot (`aws rds create-db-snapshot`, not waiting on the
automated daily window) of the live `devops-g5-db` instance, then a real restore of that
snapshot into a new, separate, temporary instance (`aws rds restore-db-instance-from-db-snapshot`,
same engine/version/class/storage/subnet-group as the source) - both real AWS API calls
against real resources, timestamped.

**Timeline (UTC):**

| Time | Event |
|---|---|
| 12:38:18 | `create-db-snapshot` issued |
| 12:38:xx-ish | snapshot reaches `available` (small DB, fast) |
| 12:49:01 | `restore-db-instance-from-db-snapshot` issued |
| 12:51:48 | AWS's own event log: "Restored from snapshot" |
| 12:52:58-12:54:01 | restored instance's own first automatic backup runs |
| by 12:56:33 | confirmed `DBInstanceStatus: available`, real endpoint address assigned |

**RTO: restore command to confirmed-available, ~7.5 minutes** (12:49:01 to 12:56:33 - an
upper bound, since the instance may have reached `available` a little before this check;
`describe-events`' 12:51:48 "Restored from snapshot" event is a lower bound, so the real
number sits somewhere in a roughly 3-7.5 minute window). Small dataset, `db.t4g.micro`,
`gp3` - a larger production dataset would take longer, but this establishes a real floor,
not a guess.

**What this drill did NOT verify, said plainly:** actual row-level data content on the
restored instance. This architecture's RDS instances sit in fully private subnets with no
public route and no bastion/ECS-Exec path configured (`enableExecuteCommand: false` on every
service) - there's no way to run a query against a temporary instance from outside the VPC
without either standing up temporary VPC-internal infrastructure (a throwaway Lambda, for
this one check) or exposing the instance publicly, and its subnets have no route to the
internet even if `publicly-accessible` were set, so that specific workaround wouldn't have
worked either. Chose not to build one-off infrastructure just to prove this once, given the
instance was going to be deleted immediately after regardless - the mechanical restore
process (AWS successfully reconstructing a working, `available` Postgres instance from a
real snapshot, in a measured time) is what's actually being claimed here, not "and the data
inside it is intact," which was never in doubt for a standard RDS snapshot/restore (it's the
same mechanism the 7-day automated backups already rely on) but also wasn't independently
re-proven by this drill.

**Cleanup:** the temporary instance (`devops-g5-db-restore-drill`) was deleted
(`skip-final-snapshot`, since it was always meant to be disposable) and the manual snapshot
removed - the live `devops-g5-db` instance was never touched by any step of this drill.

**Follow-ups (tracked in `docs/production-readiness.md`):**
- If genuine data-content verification is wanted for a future drill: the smallest real fix
  is enabling `enableExecuteCommand` on one service so a running task can `psql` against a
  restored instance directly from inside the VPC, rather than building one-off
  infrastructure per drill.
- `skip_final_snapshot = true` and `deletion_protection = false` on the real `devops-g5-db`
  instance (already disclosed as a capstone-scope trade-off) mean an accidental
  `terraform destroy` of the live instance would have no safety net beyond the 7-day
  automated backups this drill just proved are restorable - worth remembering that
  connection the next time that trade-off gets revisited.

## Drill 4 — a broken release, caught live, not staged (deploy an image that doesn't exist)

**Date:** 2026-09-21. **Owner:** sharon2719. **Not deliberately staged** - this is the same
`:bootstrap` image-tag bug `docs/scar-log.md` and `docs/production-readiness.md` document
(a `terraform apply` registered task definitions pointing at an image tag that was never
actually pushed to ECR), caught in the act while fixing an unrelated issue, and it happens
to be exactly the "deploy a broken release, catch it, demonstrate rollback" drill the G4
brief asks for - so it's recorded as that drill rather than staging a second, artificial one
on top of an already-eventful day.

**What happened, with real timestamps:** `devops-g5-pos`'s service repeatedly tried to place
a task on the broken revision and failed identically each time:

| Time (UTC+3) | Event |
|---|---|
| 16:04:13 | `CannotPullContainerError: ...pos:bootstrap: not found` |
| 16:06:29 | same error, retried |
| 16:08:36 | same error, retried |
| 16:15:22 | same error, retried |

Four failed placement attempts over 11 minutes, each ~2 minutes apart, identical error every
time. Throughout this entire window, `runningCount` for the service never dropped - the
existing healthy task on the last-known-good revision (`:12`) kept serving real traffic the
whole time (`minimumHealthyPercent=100` held), so there was **no actual user-facing outage**
from this specific failure, only a stuck, retrying deployment.

**What did NOT happen, said plainly: the deployment circuit breaker never auto-rolled-back
within the observed window.** `deployment_circuit_breaker { enable = true, rollback = true }`
is configured on every service specifically for this scenario
(`infra/ecs-service.tf`'s own comment names it). At 16:16, after 11+ minutes of identical
failures with no sign of the circuit breaker giving up and rolling back on its own, this
session manually redirected the service back to the known-good revision
(`aws ecs update-service --task-definition devops-g5-pos:12`) rather than continuing to wait
- so it's **not known whether the circuit breaker would eventually have triggered given more
time**, only that it hadn't in the first 11 minutes, and that "hasn't rolled back yet" was
indistinguishable from "will roll back eventually" from the outside. This same pattern
recurred for `commission` immediately after (same bug, same fix, plus a genuine ~2-minute
ECS scheduler backoff before recovery even after the correct image was in place - see
`docs/scar-log.md`).

**Same failure had happened before, unnoticed at the time:** `describe-services`' own event
history shows the identical `CannotPullContainerError` on `pos` on 2026-09-15, three separate
attempts, self-resolving without anyone investigating why - this bug has been latent in the
Terraform config since near the start of the project, only ever surfacing (and being noticed)
when a `terraform apply` happened to register a new task definition revision without the
image-tag variable overridden.

**Conclusion:** the "does a broken release get caught" half of this drill is answered yes -
real errors, real events, no silent failure. The "does it roll back automatically" half is
genuinely unresolved: not disproven, but not observed to work within 11 real minutes either,
and this session's own manual intervention is exactly what a real on-call engineer would
plausibly also do rather than trust an untested mechanism during an active-looking incident -
which means the circuit breaker's real-world rollback behavior for *this specific failure
mode* (image pull failure, not a failed health check after a task starts) remains unverified
either way.

**Follow-ups (tracked in `docs/production-readiness.md`):**
- Fix the root cause (the `:bootstrap` image-tag gap) properly - not just by remembering to
  pass `-var` overrides, which is exactly the kind of manual step that let this recur since
  09-15.
- If the circuit breaker's rollback behavior specifically needs to be proven (not just the
  broken-deploy-gets-caught half), that needs a *deliberately staged* drill with a bounded,
  patient wait for the full rollback timeout - not one where manual intervention happens
  first, as it did here twice today.
