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

**Slack alerting is fully built and deployed but not yet live** - the `devops-g5-alerts`
SNS topic has a Lambda subscriber (`infra/lambda/slack-notifier/index.mjs`) that formats
every alarm into the brief's required contract (environment, service, symptom, impact,
value, panel, runbook link, owner, first safe action) and posts it to a Slack webhook URL
read from Secrets Manager - but that secret is still the placeholder `"unset"`. Verified
live: invoked the deployed Lambda directly with a real alarm-shaped event, confirmed it
correctly reads the secret, detects the placeholder, and exits cleanly (no crash, no stuck
retry) rather than erroring - this is the honest, tested "not configured yet" path, not an
assumption. Also caught and fixed a real bug during that verification: `alb-elb-5xx`
alarms were matching the shorter generic `5xx` suffix first (object insertion order), which
would have misclassified every one of them with the wrong service name and a generic
message instead of its own. Fixed by sorting suffix matches longest-first. Owner:
sharon2719. Revisit: create a Slack incoming webhook and push its URL via
`aws secretsmanager put-secret-value --secret-id devops-g5-slack-webhook-url` (same
out-of-band handoff as the Daraja credentials) - no code or infra change needed after that.

**G4 found a more serious gap upstream of the Slack question entirely (`docs/recovery-drills.md`
drill 2): the direct-Lambda-invocation test above proved the Lambda's own logic works, but
never proved a real CloudWatch alarm reaching `ALARM` actually triggers it through SNS.**
Test-firing two real alarms with `aws cloudwatch set-alarm-state` produced zero SNS
`NumberOfMessagesPublished`, zero Lambda invocations, and no Slack-notifier log entries at
all, despite `ActionsEnabled: true` and correct-looking `AlarmActions`/topic-policy/Lambda
resource-policy configuration. Not yet root-caused. Owner: sharon2719. Revisit: before
trusting this stack to page anyone for a real incident - confirm whether the alarm emails
actually arrive at `tillflow4@gmail.com`, and if not, treat this as higher-priority than the
Slack webhook gap above, since email is supposed to already be the working half of this
path.

## Daraja integration (see also services/_shared/src/daraja-adapter.ts)

**`DarajaMpesaAdapter` is verified live end to end for outbound calls, deployed and running
in the real payments service with real Secrets-Manager-backed credentials; the two inbound
callback routes have never been observed to receive a real Daraja webhook.**
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

What's still unverified, and confirmed genuinely not received (twice, a day apart) rather
than just unchecked: two independent test rounds, each waiting 10+ minutes after triggering
real STK/B2C transactions against the live endpoint, each checking both `services/payments`'
own CloudWatch logs and the API Gateway's access logs (which correctly captured every other
request in both tests, ruling out a logging or routing blind spot) - zero requests to either
callback path arrived at either layer, either time. Meanwhile the query-based reconciliation
path resolved the STK transaction correctly both times (`resultCode 1037`), proving that
mechanism works regardless of whether the callback ever fires. This is now a repeatable
pattern in this sandbox environment, not a one-off timing fluke. Owner: sharon2719. Revisit:
if this needs to be provably closed, either find documentation on why Safaricom's sandbox
doesn't deliver these callbacks, or treat query-based reconciliation as the actual
production-safe mechanism and stop depending on the callback path being reliable.

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

## Registry-wide scanning (see also docs/adr/0005-shared-account-boundaries.md)

ECR enhanced (Inspector) scanning is a registry-wide singleton in a shared cohort account,
currently `BASIC`. Not managed by this group's Terraform to avoid fighting other groups'
config. Per-repository `scan_on_push` is used instead. Owner: sharon2719. Revisit: n/a —
this isn't this group's setting to change unilaterally.
