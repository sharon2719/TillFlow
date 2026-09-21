# Scar log

Real mistakes made building TillFlow, and what changed as a result - not a list of
resolved-and-forgotten bugs, but a record of what was actually wrong at some point, how it
was found, and what it cost. Ordered roughly chronologically. Cross-referenced to the commit
or evidence file that's the real proof, not a paraphrase of it.

## A money-correctness bug shipped, then was caught live against the real sandbox

`DarajaMpesaAdapter.queryTransaction` misclassified an in-flight payment as **failed**, for
two compounding reasons: Daraja's `ResultCode: 4999` ("still processing") wasn't
special-cased as pending at all, and every `ResultCode` comparison was against the string
`"0"` while Daraja actually sends a JSON *number* - meaning even a genuine successful
payment would never have matched. This is the worst class of bug this project could ship:
a payments feature that looks correct in isolation, was covered by unit tests against the
fake adapter (which never exercises real Daraja response shapes), and would have told a
real customer their payment failed when it hadn't.

**Found:** not by code review, by actually running `DarajaMpesaAdapter` against Safaricom's
real sandbox (`evidence/payments-integrity/daraja-sandbox-verification-2026-09-16.md`, Run
3) instead of trusting that "the fake adapter's tests pass" meant the real one worked.
**Fixed:** `80ae179`, plus 7 new regression tests
(`services/_shared/test/daraja-adapter.test.ts`) that assert against Daraja's actual
response shapes (numeric AND string `ResultCode`/`ResponseCode`), not the flat shape the
fake adapter used. **Lesson kept:** the fake adapter is for CI/k6 speed and determinism, not
a substitute for ever touching the real integration - G2's "only the fake adapter exists" is
exactly the gap that would have hidden this indefinitely.

## Real secrets almost landed in a git-tracked file

While wiring real Daraja credentials, they were pasted into the git-tracked
`.env.daraja.example` template instead of the git-ignored `.env.daraja.local`. Caught before
any commit - `git status` and `git check-ignore -v` were run immediately after, confirmed
nothing was ever staged, and the example file was restored via `git checkout --`. **Nothing
was ever exposed**, but it's recorded here because it's exactly the kind of mistake that
would have if the very next step had been `git add -A` instead of checking first. **Lesson
kept:** verify via `git status` after *any* credential-bearing file edit, not just before a
commit - a memory rule for this session now says so explicitly.

## A dashboard that "loaded" was quietly showing nothing

Two real bugs sat in the Grafana dashboard undetected because "the JSON is structurally
valid and the panels render" was mistaken for "the panels show data": every ALB-metric
panel was missing the `LoadBalancer` dimension entirely and used bare `TargetGroup` names
instead of the full ARN-suffix format CloudWatch actually requires - so every one of those
panels was silently empty. Separately, the datasource provisioning YAML never pinned a
`uid:`, so Grafana auto-generated one that didn't match the `"uid": "CloudWatch"` every
panel had hardcoded, which would have shown a "datasource not found" panel error the moment
anyone actually looked instead of just trusting the dashboard's JSON was fine. **Found:** by
querying the real CloudWatch metrics directly (`aws cloudwatch get-metric-statistics`) and
comparing against what the dashboard would have needed to show the same numbers, then
testing Grafana's own `/api/ds/query` endpoint directly rather than eyeballing the rendered
page. **Lesson kept:** a dashboard that loads without a JSON error is not the same claim as
a dashboard that shows correct data - verify against the real metric source, not the
rendering layer.

## CloudWatch Synthetics turned out to be impossible in this account, not just unconfigured

Terraform's `aws_synthetics_canary` resource requires `memory_in_mb >= 960`; this shared
cohort AWS account caps Lambda functions at `<= 512MB`. These aren't a configuration choice
that could be tuned around - they're mutually exclusive, confirmed by a real failed
`terraform apply` (`'MemorySize' value failed to satisfy constraint: Member must have value
less than or equal to 512`), not a guess from reading docs. **Cost:** a canary resource was
created, hit the wall, and had to be torn down (`terraform state rm` + `aws synthetics
delete-canary`) before pivoting to a plain scheduled Lambda that achieves the same
external-probe goal within the account's real limits (`fde4499`,
`infra/external-probe.tf`). **Lesson kept:** when a managed AWS feature and an account-level
guardrail conflict, that's worth confirming with a real failed apply before spending more
time trying to configure around it - and worth disclosing as an environmental constraint,
not silently pivoting without saying why.

## A local load test's "bug" was actually Docker Desktop crashing

The 15-minute k6 soak test's business-flow scenario failed 0/90 iterations. The first
plausible read was an application bug in `pos`'s tenant-creation path. It wasn't: Docker
Desktop itself crashed mid-run on the machine running the test, taking the disposable local
Postgres container down with it, which surfaced as `ECONNREFUSED` inside `pos`'s own logs.
It then crashed two more times while trying to get a clean re-run. **Lesson kept:**
`docs/load-tests.md`'s Run 4 records this honestly as a documented local-harness failure
with the real root cause traced, not silently re-run until it looked clean, and not written
up as if the business-flow chain itself were broken (Run 1, against the real deployment,
already proved that chain works under concurrent load).

## An alert path that "looked" correctly configured couldn't be shown to actually deliver

`docs/recovery-drills.md` drill 2 test-fired two real CloudWatch alarms
(`aws cloudwatch set-alarm-state`) specifically to rehearse the runbook end-to-end instead of
just reading it. Both produced genuine, timestamped `OK -> ALARM -> OK` transitions in
`describe-alarm-history`. Neither produced a single SNS `NumberOfMessagesPublished`
datapoint, Lambda invocation, or Slack-notifier log line - despite `ActionsEnabled: true`
and correct-looking `AlarmActions`/topic-policy/Lambda-resource-policy on static review.
**Isolated on 2026-09-18, fixed for real on 2026-09-21 - not left as a permanent shrug.** A
direct `aws sns publish` to the same topic reached the Slack-notifier Lambda in under a
second, and a third test-fire, checked within seconds of a genuine `ALARM` transition, still
produced nothing - ruling out both "SNS itself is broken" and "the state change reverted
before the action could fire." The break was specifically in CloudWatch's own alarm-action
invocation. The earlier "Slack verified live" claim in `docs/production-readiness.md` only
ever invoked the Lambda directly, which is precisely why this gap survived until an actual
rehearsal caught it. **Lesson kept:** testing a component in isolation (the Lambda) is not
the same claim as testing the path that's supposed to reach it (a real alarm through SNS) -
the same shape of mistake as the Grafana dashboard scar above, one layer further up the
stack.

**The eventual fix took two more rounds of the exact same discipline - test live, don't
guess - and found a second, unrelated root cause along the way.** Confirmed the native
CloudWatch mechanism's failure wasn't a KMS/encryption problem first (a live test: a fresh
*unencrypted* test topic + test alarm still produced nothing), so the plan became "stop
depending on that mechanism" - an EventBridge rule independently catching "CloudWatch Alarm
State Change" events, a genuinely different code path. That new path then failed too, on
its first real test-fire. Rather than assume the same unexplained cause, a second isolated
live test (identical EventBridge target, one fresh encrypted topic and one fresh unencrypted
one, side by side) showed encryption specifically *was* the blocker for EventBridge - the
opposite conclusion from the first diagnostic, for a different mechanism. Fixed by removing
KMS encryption from the real alerts topic. **Lesson kept:** "already ruled out for one
mechanism" doesn't transfer to a different mechanism touching the same resource - each one
needed its own live test, not an inference from the other's result, and skipping that step
would have shipped a bridge that still didn't work while believing the KMS question was
already closed.

## A real credential rotation crash-looped payments in production, unnoticed

Not found by a drill - found by accident while setting up the backup/restore drill.
`payments` was crash-looping on every database request (`password authentication failed`,
an uncaught error that killed the whole process each time) because RDS's own managed
rotation had changed the master password that morning and `payments` hadn't redeployed since
to pick up the fresh value. `pos` and `commission` share the exact same exposure and were
only spared by the coincidence of having redeployed more recently - not by anything that
was actually designed to handle this. No alarm fired, because every service's health check
is deliberately DB-independent (so a slow query never means a bad deploy), which also means
a *fully broken* DB connection is invisible to it. Fixed with one `--force-new-deployment`
call once found. Full account: `docs/recovery-drills.md`'s "Incident 1". **Lesson kept:**
"nothing alarms because nothing's actually broken" and "nothing alarms because the thing
that checks for broken is blind to this specific kind of broken" look identical from the
outside - the difference only showed up by directly exercising the DB-writing endpoints,
not by trusting three green health checks.

## A single terraform apply chained into three compounding self-inflicted incidents

Fixing the `/ready`-doesn't-check-the-DB gap meant two separate changes: application code
(a real `/ready` route on `payments`/`commission`) and infrastructure (pointing their ALB
target groups' health checks at `/ready` instead of `/health`). Applying just the infra half
turned into a real, live, multi-act incident - each fix uncovering the next problem, not one
clean mistake:

**Act 1 - infra applied ahead of the code it depended on.** Terraform manages the target
group's health check path directly; the running task's actual code is owned by the separate
CI/CD deploy pipeline (`lifecycle.ignore_changes = [task_definition]` on every
`aws_ecs_service`, deliberately, so Terraform and the pipeline don't fight over which
revision is running). Applying the Terraform change alone switched the ALB to health-check
`/ready` on containers still running the OLD image, which had no `/ready` route - immediate
`404`s, both `payments` and `commission` marked unhealthy, ECS's replace-on-failure stuck in
a loop replacing a task with the identical (still `/ready`-less) image. Fixed by reverting
the target groups back to `/health` directly (`aws elbv2 modify-target-group`, run by the
user - the same class of live-mutation this session can't perform itself).

**Act 2 - the manual fix wasn't durable, and a real, separate bug surfaced when reapplying.**
The `aws elbv2 modify-target-group` fix was out-of-band - Terraform's own config still said
`/ready`. Reapplying Terraform (to add the `pos_image_tag`/`commission_image_tag` variables
needed for Act 3) silently reverted the manual fix back to `/ready`, re-breaking the exact
same two services the same way. **Lesson kept, the hard way:** an out-of-band `aws` CLI fix
against a Terraform-managed resource is temporary by construction - it lasts exactly until
the next `terraform apply`, and *will* be silently undone unless the source file itself is
also fixed. Fixed for real this time by editing `infra/alb.tf` directly (reverting the health
check path in the actual `.tf` source, with a comment explaining not to flip it back without
the code) and reapplying - config drift can't resurface what the config itself no longer
says.

**Act 3 - a real, previously-undiscovered Terraform gap: task definitions silently default
to a nonexistent image.** While debugging Act 1, `pos`'s and `commission`'s new task
definition revisions (registered by the same `terraform apply`) turned out to reference
`...:bootstrap` - the `pos_image_tag`/`commission_image_tag` variables' hardcoded default,
meant only for a service's very first bootstrap deploy before CI has ever run. Every real
deploy since has been driven by CI directly updating the *service* to a new
SHA-tagged revision, never by Terraform - so Terraform's own copy of "the current image tag"
had been stale since the first real deploy, and nothing had ever surfaced that staleness
until this apply actually tried to register a fresh revision from it.
`aws ecs describe-services` confirmed the real cause directly:
`CannotPullContainerError: ...pos:bootstrap: not found` - that tag was never even pushed to
ECR for real, since CI has only ever pushed SHA tags. **Fixed** by re-applying with explicit
`-var="pos_image_tag=<real sha>" -var="commission_image_tag=<real sha>"` overrides (the real
running SHA, read off the last known-good task definition first), which correctly produced
new revisions with both the intended env var changes *and* the real image. **Still an open
structural gap, not fully closed**: nothing prevents a *future* plain `terraform apply`
(without those overrides) from silently reintroducing this exact failure the next time
anyone needs to change anything else on these task definitions. The real fix is making the
image tag variable read the currently-running image automatically (a `data` source against
the live service) instead of trusting a variable that's only ever right by coincidence.

**Recovery, and one more real wrinkle:** even after every underlying cause was fixed,
`commission`'s ECS service sat at `runningCount: 0` for a genuinely long stretch (~2 minutes)
with no new placement attempts visible in its own events - not a new failure, but AWS's own
service-scheduler backoff after the earlier repeated failures in quick succession. Recovered
on its own; confirmed via the real public endpoint returning `200` and the commission log's
own `"commission scheduled-close worker started"` line, not just an ECS status field.
**Lesson kept:** after a service has failed repeatedly, "fixed" doesn't mean "instantly
recovered" - AWS's own backoff is a real, sometimes multi-minute part of the actual recovery
time, worth expecting rather than being alarmed by.

**The throughline across all three acts, worth stating plainly:** every one of these was
caused by an action taken *in this session*, found and fixed in real time, not inherited or
discovered after the fact - the opposite of overstating what's solid. Documented here in
full because a scar log that only records other people's incidents and skips its own isn't
honest about what "real mistakes" means.

## Recurring, smaller ones worth naming once instead of repeating silently

- **Windows/Git-Bash path translation** bit file writes more than once: a Node/Python
  script given a Git-Bash-style path (`/c/Users/...`) instead of a Windows-native one
  (`C:/Users/...`) fails to find the file, even inside the same shell session that just
  wrote it. Fixed by standardizing on Windows-style paths for any script invoked directly
  (not through Git Bash's own path translation).
- **Stale `tsx watch` processes outliving their intended restart**: stopping a tracked
  background task didn't always kill the actual spawned Node child on Windows, leaving an
  old process still bound to the port and silently serving outdated code - misread once as
  an application regression before `netstat`/`Stop-Process` confirmed it was a leftover
  process, not a code bug.
