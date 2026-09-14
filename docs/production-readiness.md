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

**DynamoDB lock table has no point-in-time recovery, no customer-managed KMS key**
(`infra/bootstrap/main.tf`, Trivy AWS-0024/AWS-0025 — MEDIUM/LOW, doesn't fail CI's
HIGH/CRITICAL gate but tracked here anyway)
It's a lock table, not a data store — losing it loses nothing but a lock, recreatable at
will. Owner: sharon2719. Revisit: low priority, only if this pattern gets reused somewhere
that isn't just a Terraform lock table.

**tfstate S3 bucket has access logging disabled** (`infra/bootstrap/main.tf`, Trivy
AWS-0089 — LOW)
Owner: sharon2719. Revisit: cheap to add, will do alongside the next bootstrap change.

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

## Registry-wide scanning (see also docs/adr/0005-shared-account-boundaries.md)

ECR enhanced (Inspector) scanning is a registry-wide singleton in a shared cohort account,
currently `BASIC`. Not managed by this group's Terraform to avoid fighting other groups'
config. Per-repository `scan_on_push` is used instead. Owner: sharon2719. Revisit: n/a —
this isn't this group's setting to change unilaterally.
