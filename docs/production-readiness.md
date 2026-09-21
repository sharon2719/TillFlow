# Production readiness — known gaps and accepted risks

This is a running log of deliberate trade-offs: things that are correct for a capstone's
scope/cost/timeline but would need revisiting before this ran for real. Each entry has an
owner and a revisit trigger, per the brief's requirement to log accepted risk rather than
silently ignore a scan finding. "Fixed later" items belong in `docs/scar-log.md` instead —
this file is for things being knowingly left as-is right now.

## External synthetic probe (see also infra/external-probe.tf)

**Built as a plain scheduled Lambda, not CloudWatch Synthetics - confirmed as a real account
constraint, not a design preference.** A `aws_synthetics_canary` resource was applied for
real against this account and failed: `'MemorySize' value failed to satisfy constraint:
Member must have value less than or equal to 512`. Synthetics canaries run as a Lambda
function under the hood and AWS's own API enforces a 960MB minimum for that function; this
shared cohort account caps every Lambda's memory at 512MB. Those two constraints are
mutually exclusive here, so CloudWatch Synthetics cannot run in this account at all -
confirmed live (the partially-created canary was deleted after the failed apply), not
assumed from documentation. `infra/lambda/external-probe/index.mjs` does the same job
(external HTTP check on a 1-minute schedule, from outside the VPC, emitting a custom
CloudWatch metric an alarm watches) within the account's real limits - verified live: a
real run logged a real 200 response and published a real `ProbeSuccess=1.0` datapoint that
the new alarm correctly evaluated. Owner: sharon2719. Revisit: if this project ever moves
to an account without that Lambda memory restriction, either is fine - the current Lambda
approach isn't a lesser substitute functionally, just a different implementation of the
same requirement.

## Alerting (see also infra/slack-notifier.tf, infra/burn-rate-alerts.tf)

**Alerting is live, confirmed end to end for real on 2026-09-21 - both the Slack posting
mechanism and, separately, the actual alarm-delivery path that was broken.** The
`devops-g5-alerts` SNS topic has a Lambda subscriber (`infra/lambda/slack-notifier/index.mjs`)
that formats every alarm into the brief's required contract (environment, service, symptom,
impact, value, panel, runbook link, owner, first safe action) and posts it to a Slack
webhook URL read from Secrets Manager. Verification history, in order:

1. Invoked the deployed Lambda directly with a real alarm-shaped event while the secret was
   still the placeholder `"unset"`, confirming it detected that and exited cleanly - the
   honest "not configured yet" path. Also caught and fixed a real bug: `alb-elb-5xx` alarms
   matching the shorter generic `5xx` suffix first (object insertion order) - fixed by
   sorting suffix matches longest-first.
2. A real Slack webhook was populated; re-invoking the Lambda directly confirmed the message
   actually arrived in the Slack channel (owner-verified visually).
3. **A confirmed, isolated, upstream gap** (`docs/recovery-drills.md` drill 2): a real
   CloudWatch alarm reaching `ALARM` did not result in CloudWatch calling `sns:Publish` at
   all - proven via a direct `aws sns publish` reaching the Lambda in under a second (SNS
   delivery itself fine) while a genuine, timing-verified `ALARM` state produced nothing.
   Confirmed with the `tillflow4@gmail.com` owner that email had the identical gap - both
   channels sat downstream of the same broken step, not two separate problems.
4. **Fixed for real via two live-diagnosed changes, not a guess**: `infra/alarm-eventbridge-bridge.tf`
   adds an EventBridge rule that catches "CloudWatch Alarm State Change" events independently
   of an alarm's own `AlarmActions` (proven via a live diagnostic that CloudWatch's native
   mechanism fails even against a fresh unencrypted topic - the root cause there remains
   genuinely unexplained, worked around rather than fixed). That EventBridge path had its
   own, separate blocker - KMS encryption on the alerts topic, isolated via a second live
   diagnostic (identical EventBridge target against a fresh encrypted vs. unencrypted topic)
   - fixed by removing `aws_sns_topic.alerts`'s KMS encryption (`infra/monitoring.tf`; the
   topic never carried customer data, so this isn't a new risk, and the old
   `trivy:ignore:AWS-0136` reasoning already argued exactly this).
5. **Re-verified end to end via the real path**, not a component test: fired
   `devops-g5-pos-5xx` with `set-alarm-state`, confirmed the Lambda ran within 3 seconds via
   `CloudWatch -> EventBridge -> SNS -> Lambda`, and the owner visually confirmed the message
   in Slack.

Owner: sharon2719. **What's still genuinely open**: why CloudWatch's own native
`AlarmActions` mechanism doesn't work on this account at all - the EventBridge bridge is a
durable, correct fix for real alert delivery, not a workaround pretending to be a fix, but
it doesn't explain the original mystery. If that's ever wanted, next step is checking for an
AWS Organizations guardrail or filing an AWS Support case - not diagnosable further from the
CLI surface available to this IAM role.

## Daraja integration (see also services/_shared/src/daraja-adapter.ts)

**`DarajaMpesaAdapter` is verified live end to end for outbound calls, deployed and running
in the real payments service with real Secrets-Manager-backed credentials. As of a 2026-09-18
follow-up (`evidence/payments-integrity/end-to-end-demo-2026-09-18.md`), the inbound STK
callback route has now been observed receiving a real Daraja webhook - 28 seconds after an
STK push, after two earlier dedicated tests each waited 10+ minutes with nothing arriving.
Delivery is real but unpredictable, not absent.**
`evidence/payments-integrity/daraja-sandbox-verification-2026-09-16.md` records real runs
against the sandbox: a token exchange, an STK push (`ws_CO_...` CheckoutRequestID), a query
resolving to a real terminal state (`resultCode 1037`, "DS timeout user cannot be reached" -
expected, the sandbox test number has no real device behind it), and a B2C payout
(`AG_...` ConversationID) - all repeated directly against the live deployed service (task
definition revision `:5`) after merging, not just locally. Live testing also caught and
fixed a real bug: Daraja's `ResultCode`/`ResponseCode` arrive as JSON numbers, and `4999`
("still processing") was falling through to `"failed"` instead of `"pending"` - directly
threatening the "a timeout is never a decline" guarantee. Now covered by 7 deterministic
unit tests in `services/_shared/test/daraja-adapter.test.ts`.

**What's still unverified: a real Daraja completion of the full `paid -> commission ->
B2C` path.** The 09-18 callback that did arrive resolved as `ResultCode 1037, "No response
from user"` - a genuine decline, since the shared sandbox test MSISDN has no real phone
behind it to approve the STK prompt, not a "paid" outcome. Commission close correctly
excluded the failed sale from any payout (`eligibleSales: 0`), live - but reaching "paid"
with a *real* Daraja transaction would need either a real test phone approving the prompt,
or documentation on how to make the sandbox return success, neither available here. The
`FakeMpesaAdapter` remains the only way this project has reached "paid" on demand; treated
as a disclosed, deliberate substitution (see the end-to-end-demo evidence file), not a
silently-skipped step. Owner: sharon2719. Revisit: if a real "paid" completion is still
wanted, look into Daraja sandbox test credentials/numbers documented to succeed rather than
decline, since `254708374149` (Safaricom's own published one) evidently doesn't.

**`DarajaMpesaAdapter.queryTransaction` can't resolve a B2C `conversationId`.** Daraja has
a dedicated STK query endpoint keyed by `checkoutRequestId`, but no equivalent single call
for B2C - it resolves purely via the `ResultURL` callback. Given a conversationId, this
method returns `"pending"` honestly rather than guessing. Owner: sharon2719. Revisit: if
B2C reconciliation (not just the callback path) turns out to be needed, look at Daraja's
Transaction Status API (`/mpesa/transactionstatus/v1/query`) - lower confidence than the
STK query endpoint, deliberately not implemented against without live testing first.

**CI/k6 always get `FakeMpesaAdapter`, never the real one** - `services/payments/src/app.ts`
only picks `DarajaMpesaAdapter` when all seven `DARAJA_*` env vars are set, and nothing in
CI or the k6 load test sets them. This is intentional (the brief requires the fake for
CI/k6 regardless of what's built), not an oversight to fix later.

## Async infrastructure (see also infra/async.tf)

**ElastiCache and the SQS commission-close queue now have real, if deliberately narrow,
consumers (G4).** `services/pos/src/cache.ts` wires the Redis replication group in as a
read-through cache in front of `requireAuth`'s API-key lookup - the one DB round trip every
authenticated request makes, and `docs/capacity-report.md`'s working hypothesis for pos's
Run-1 SLO miss. `services/commission/src/worker.ts` long-polls the commission-close queue
and records every trigger it receives in `commission.scheduled_runs`
(`migrations/002_scheduled_runs.sql`). **What this still isn't:** the worker does not
perform full cross-tenant sales reconciliation (aggregating every tenant's paid sales for
the day and calling `close` on their behalf) - that would need a cross-service data source
that doesn't exist yet (ADR-0003 rules out cross-service SQL joins; nothing currently
exposes "list today's paid sales" over HTTP either) and an internal service-to-service auth
mechanism (today's only auth model is a tenant-scoped API key, ADR-0007). Recording the
trigger is real, honest work that gives the queue a genuine consumer with genuine
success/failure/DLQ behavior - it is not a stand-in for the full feature. Owner: sharon2719.
Revisit: build the cross-tenant reconciliation once pos exposes a way to list a tenant's
sales needing close and a service-to-service auth story exists.

## Networking

**Single NAT gateway, not one per AZ** (`infra/network.tf`)
A NAT-side AZ outage takes down private-subnet egress for both AZs at once, not just one.
Cost trade-off for a capstone (a second NAT gateway roughly doubles that line item for
redundancy this project doesn't need yet).
Owner: sharon2719. Revisit: only if this ever ran with real traffic outside the capstone.

**Internal ALB listener is plain HTTP, not HTTPS** (`infra/alb.tf`, `aws_lb_listener.pos`,
Trivy AWS-0054)
The ALB is unreachable except through the API Gateway VPC Link, and every public request
already gets TLS terminated at the API Gateway edge — this is the internal hop only.
Adding HTTPS here needs an ACM certificate, which needs a domain this project doesn't have.
Owner: sharon2719. Revisit: before G5, or sooner if a real domain gets attached to the API.

**`pos_task` security group allows HTTPS egress to 0.0.0.0/0** (`infra/security-groups.tf`,
Trivy AWS-0104)
ECR image pulls, CloudWatch Logs, X-Ray, and STS are all reached as public AWS API
endpoints via the NAT gateway — there are no VPC interface/gateway endpoints for them yet.
The real fix is VPC endpoints for `ecr.api`, `ecr.dkr`, `logs`, `xray`, `sts` (interface)
and `s3` (gateway, free), which would let this egress rule shrink to the VPC CIDR only.
Not done yet: interface endpoints run ~$7-8/month each, and 4-5 of them isn't justified
for the current golden-path scope.
Owner: sharon2719. Revisit: before G5, or immediately if cost budget allows.

## Database (see also docs/adr/0003-database.md)

**Single-AZ RDS, no Multi-AZ failover** — disclosed cost trade-off, logged in the ADR
already. Owner: sharon2719. Revisit: before this ran for real.

**pos connects to RDS with `rejectUnauthorized: false`** (`services/pos/src/db.ts`)
The connection is still encrypted in transit (RDS requires TLS by default), but the server
certificate isn't verified against the RDS CA bundle, so it's not protected against a
man-in-the-middle inside the VPC. Pinning the actual RDS CA bundle is a small, known fix -
just not done in this first pass.
Owner: sharon2719. Revisit: before this ran for real, or whenever the payments service's DB
connection is being set up anyway (do both at once).

**No per-service least-privilege DB role yet — pos connects with the RDS master
credential** (`infra/rds.tf`, `infra/ecs-task-def.tf`)
ADR-0003 calls for a dedicated role per service; this uses schema-level separation
(`pos.*` tables) with the shared master credential instead, since building that properly
means either an imperative bootstrap script or pulling in a whole extra Terraform provider
(`cyrilgdn/postgres`) to manage roles/grants declaratively — real scope, not a one-line
addition, and not worth it for a single-service database yet.
Owner: sharon2719. Revisit: when payments becomes the second service sharing this
instance — that's the point where schema-only separation stops being enough and a real
credential boundary between services actually starts mattering.

**~~DynamoDB lock table has no point-in-time recovery, no customer-managed KMS key~~ — fixed
2026-09-15.** Both were cheap to add while touching this resource for the naming/tag audit
(`infra/bootstrap/main.tf`): PITR enabled, encryption now uses the same KMS key as the
tfstate bucket instead of the AWS-managed default.

**~~tfstate S3 bucket had no HTTPS-only bucket policy~~ — fixed 2026-09-15.** Found by the
IDE's own Terraform linter while editing this file for the tag audit (Trivy hadn't flagged
it), not something to leave sitting once seen: added a policy denying any request where
`aws:SecureTransport` is false.

**tfstate S3 bucket still has access logging disabled** (`infra/bootstrap/main.tf`, Trivy
AWS-0089 — LOW)
Needs a target bucket to log to. That's the `logs` bucket from `docs/adr/0004`, which
doesn't exist yet either — deliberately not building it as a side effect of this audit pass,
since that's real scope on its own (bucket + lifecycle + the log-delivery grant), not a
one-line addition like the other two above.
Owner: sharon2719. Revisit: when the `logs`/`artifacts`/`backups`/`evidence` buckets from
ADR-0004 get built.

**ALB access logs not configured** (`infra/alb.tf`, flagged by the IDE's own Terraform
linter while adding tags there for the audit)
Same root cause as the item above - needs the same `logs` bucket from ADR-0004. Tracked
here as its own line since it's a separate resource, but it's the same underlying gap and
the same fix.
Owner: sharon2719. Revisit: same as above.

**VPC Flow Logs not enabled** (`infra/network.tf`, Trivy AWS-0178 — MEDIUM)
Would help incident investigation but adds a CloudWatch Logs cost for a capstone that
isn't being attacked. Owner: sharon2719. Revisit: before G4's failure drills, since flow
logs would make a couple of those drills easier to narrate.

## CI/CD

**Infra apply has no formal reviewer-approval gate** (`.github/workflows/infra-apply.yml`)
The original design used a GitHub Environment's "required reviewers" protection rule.
Confirmed directly in the repo's environment settings that this section doesn't render at
all — it's a paid-plan feature (Pro/Team/Enterprise) for private repositories, not available
on this repo's current plan. Replaced with a manual-trigger-only workflow (no automatic
apply on merge at all): a human has to deliberately open Actions and run it. Weaker than a
real reviewer step, but still a genuine gate, and free.
Owner: sharon2719. Revisit: if this repo ever moves to a paid GitHub plan, add a required
reviewer to the `infra-apply` environment and switch the workflow back to triggering on
push - both are small, contained changes.

## Observability (see also docs/slo-error-budgets.md, docs/runbook.md, docs/recovery-drills.md)

**`desired_count = 1` everywhere, kept deliberately.** `docs/recovery-drills.md`'s drill 1
measured the real cost of this: a ~30-40s gap with no alarm on every task replacement,
including every routine deploy, not just a failure. The missing alarm for that gap is now
fixed (`aws_cloudwatch_metric_alarm.alb_elb_5xx`), but the gap itself — and the unhealthy-host
alarm's 2-minute window staying longer than a fast self-healing event — remain. Decided to
keep `desired_count = 1` rather than pay roughly double the Fargate cost per service to close
a ~30-40s window, given this is a capstone with no real user traffic at stake. Owner:
sharon2719. Revisit: before this ever carries real production traffic, or if the pos p95
SLO miss in `docs/load-tests.md` is confirmed to be capacity-related rather than a one-off.

**`pos` missed its own p95 latency SLO under concurrent load, cause not yet confirmed.**
`docs/load-tests.md`'s run 1: 462.9ms p95 against a 400ms target, while CPU stayed under
5%. Working hypothesis is event-loop contention with `pos`'s own DB-writing endpoints
(single Fargate task, `desired_count = 1`), not the health check itself doing more work -
same underlying capacity gap the recovery drill above found from the task-kill angle, now
a second independent data point. Owner: sharon2719. Revisit: profile with X-Ray span
timing to confirm the cause, then re-run the load test after any capacity change.

**Alarms are built on ALB/RDS metrics, not the SLO table's actual numerators.**
`infra/monitoring.tf`'s alarms answer "is the API up and responding reasonably fast" using
metrics CloudWatch already collects for free (5xx count, target response time, healthy host
count). The SLO table's real numerators — e.g. "valid sale writes accepted exactly once",
"eligible payouts reaching a terminal state by 06:30 EAT" — need each service to emit its
own business-level success/failure/latency metrics (via the ADOT sidecar already in every
task, which currently only carries traces to X-Ray, not custom metrics). Until that's built,
burn-rate against the written SLO targets isn't actually measurable, only approximated.
Owner: sharon2719. Revisit: once G3's alerting is validated against real traffic, add
OTel metric instrumentation per service for the specific SLI numerators.

**The alerts SNS topic uses the AWS-managed key, not a customer-managed CMK**
(`infra/monitoring.tf`, `trivy:ignore:AWS-0136`). A CMK needs its own key policy granting
CloudWatch/SNS permission to use it for publishing - get that policy subtly wrong and the
alarm still fires and shows ALARM in the console, but the notification email silently never
decrypts and sends, which is a worse failure mode than the compliance gap it would close.
The topic only ever carries alarm names/descriptions, never customer data. Owner:
sharon2719. Revisit: before G5, or if this topic is ever used to carry anything more
sensitive than alarm text.

**No slow-query log or RDS Performance Insights.** `rds-cpu` firing tells you the shared
instance is under load, not which service or query caused it. Owner: sharon2719. Revisit:
enable Performance Insights (free tier covers 7 days retention) next time the RDS resource
is touched for another reason, to avoid a standalone apply just for this.

**CloudWatch Container Insights isn't enabled**, so there's no native
"runningCount < desiredCount" ECS alarm — `<service>-unhealthy` (ALB-level) is the closest
proxy today. Owner: sharon2719. Revisit: before G4, since failure drills will want a faster,
more direct signal than "the ALB stopped seeing a healthy target."

## Credential rotation can silently crash-loop a service (see docs/recovery-drills.md, Incident 1)

**RDS's managed master-password rotation (`rotationEnabled: true`) crash-looped `payments`
in production on 2026-09-21** - not a drill, found live. `pos` and `commission` share the
same rotation and the same failure mode, but happened to have redeployed since the rotation
landed and so already held the fresh credential; `payments` hadn't redeployed and crashed
outright on every DB-touching request until manually force-redeployed. Two real gaps found:

1. **Nothing restarts a DB-dependent service when its credential rotates** - three services
   surviving this time was luck, not a mechanism. **Still open.**
2. **Every service's health/readiness check was DB-independent by design**, so a fully
   DB-broken service reported itself healthy indefinitely - this is also why none of the
   alarms in `infra/monitoring.tf` fired, on top of drill 2's separate finding that alarm
   delivery itself doesn't work. **Fixed same-day**: `pos`, `payments`, and `commission` all
   now have a real `/ready` route (`SELECT 1` against the DB, `503` on failure, tested for
   both outcomes). Applying the ALB side of this fix (`infra/alb.tf` health-checking `/ready`
   instead of `/health`) ahead of the `payments`/`commission` code being deployed caused a
   second, real, self-inflicted incident the same day - see `docs/scar-log.md`. Current live
   state: `pos`'s target group is on `/ready` (safe - its route pre-dates this fix);
   `payments`'s and `commission`'s target groups are back on `/health` until their `/ready`
   code is actually deployed.

Owner: sharon2719. Revisit gap 1 before this ever carries real traffic - either disable
automatic rotation (documented security trade-off) or wire an EventBridge rule on the
rotation event that force-redeploys all three DB-dependent services. Gap 2's code fix exists
but needs a real deploy to prove it catches this class of failure live, not just in tests.

## Task definition image tags silently default to a nonexistent placeholder

**`pos_image_tag`/`payments_image_tag`/`commission_image_tag`/`web_image_tag`/
`grafana_image_tag` all default to `"bootstrap"`, a tag that was never actually pushed to
ECR for real** - real deploys have only ever pushed SHA tags, driven entirely by CI directly
updating each `aws_ecs_service` to a new revision (`lifecycle.ignore_changes =
[task_definition]`, so Terraform never sees or records what CI actually deployed). This
means Terraform's own idea of "the current image" has been stale since each service's first
real deploy, and any `terraform apply` that registers a new task definition revision for any
reason - not just an image change, *any* change to that resource - without an explicit
`-var="<service>_image_tag=<real sha>"` override will silently produce a revision pointing
at a nonexistent image. Confirmed live and the hard way, not by inspection:
`docs/scar-log.md`'s "three compounding incidents" - a real `terraform apply` for an
unrelated env-var change did exactly this to `pos` and `commission`, producing
`CannotPullContainerError: ...:bootstrap: not found` the moment either was deployed. Owner:
sharon2719. Revisit: before the next infra change touches any ECS task definition - either
always pass the current real SHA as a `-var` (fragile, relies on remembering), or replace the
variable with a `data "aws_ecs_task_definition"` lookup against the live service so Terraform
reads the actually-running image instead of trusting a variable that's only ever correct by
coincidence.

## Registry-wide scanning (see also docs/adr/0005-shared-account-boundaries.md)

ECR enhanced (Inspector) scanning is a registry-wide singleton in a shared cohort account,
currently `BASIC`. Not managed by this group's Terraform to avoid fighting other groups'
config. Per-repository `scan_on_push` is used instead. Owner: sharon2719. Revisit: n/a —
this isn't this group's setting to change unilaterally.
