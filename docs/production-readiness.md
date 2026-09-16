# Production readiness — known gaps and accepted risks

This is a running log of deliberate trade-offs: things that are correct for a capstone's
scope/cost/timeline but would need revisiting before this ran for real. Each entry has an
owner and a revisit trigger, per the brief's requirement to log accepted risk rather than
silently ignore a scan finding. "Fixed later" items belong in `docs/scar-log.md` instead —
this file is for things being knowingly left as-is right now.

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

**No alarm on ELB-level 5xx, only per-target-group 5xx.** Confirmed by
`docs/recovery-drills.md`'s drill 1: when a service has zero healthy targets, the ALB
itself returns a 503 (`HTTPCode_ELB_5XX_Count`), which is a different metric from a target
actually returning a 5xx (`HTTPCode_Target_5XX_Count` — what `infra/monitoring.tf` alarms
on today). A "no healthy target" event that resolves inside the unhealthy-host alarm's
2-minute window is currently invisible to every alarm in the stack. Owner: sharon2719.
Revisit: add an `HTTPCode_ELB_5XX_Count` alarm per load balancer; decide whether
`desired_count = 2` is worth it for services where the 99.9% SLO budget is tight, given
every deploy (not just a failure) causes this same brief gap today.

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
