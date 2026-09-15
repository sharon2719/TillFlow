# TillFlow

Multi-tenant POS + M-Pesa (Daraja) payments, on AWS ECS. Solo capstone build — see
`docs/ownership.md` for why every area still names one DRI even with a group of one.

## Status (2026-09-15)

**G1 (Platform) is done.** The full golden path is live in AWS: VPC, ECS cluster running
`pos` behind an internal ALB, an ADOT sidecar per task, ECR, and a public API Gateway HTTP
API in front of it all. `.github/workflows/deploy-pos.yml` is the real deploy pipeline —
build, push to ECR by commit SHA, run migrations as a one-off ECS task, register a new task
definition revision, update the service, wait for stability, smoke-test the public endpoint.
`.github/workflows/ci.yml` runs a real `terraform plan` against AWS on every PR (OIDC, no
long-lived keys); `infra-apply.yml` applies on manual trigger (GitHub's reviewer-approval
environments aren't available on this plan for a private repo — see
`docs/production-readiness.md`). A naming/tag audit script
(`infra/scripts/audit_naming_tags.py`) has actually been run against live AWS, not just
written.

**G2 (Product) is underway.** RDS (PostgreSQL) is live — `pos`'s first real dependency,
schema-per-service per `docs/adr/0003`. Tenant setup is built and tested: `POST /tenants`
bootstraps a tenant + owner (returns an API key exactly once), `POST /attendants` and
`POST`/`GET /tills` are API-key-authenticated and tenant-scoped, with an explicit
cross-tenant isolation test proving the scoping actually holds (`docs/adr/0007`). Sale
recording is next, then Payments/Commission/Web and ElastiCache/SQS/EventBridge — added
once a service actually needs them, same pattern throughout.

This README updates as each gate lands, not written once at the end.

## Prerequisites

- Node.js 22, npm 10+
- Docker
- Terraform ~1.9+ (validated against 1.15 locally)
- An AWS account with credentials configured for `eu-west-1` (see `docs/adr/0002-region.md`)

## Stand up the Terraform backend (one-time, by hand)

```bash
cd infra/bootstrap
terraform init
terraform apply   # creates the tfstate bucket + lock table
terraform output  # copy these into infra/backend.tf, then terraform init there too
```

## Bootstrap / run locally

```bash
npm install
npm run typecheck --workspace=@tillflow/pos
npm run test --workspace=@tillflow/pos
npm run dev --workspace=@tillflow/pos   # http://localhost:3000/health
```

## Build the pos image

```bash
docker build -f services/pos/Dockerfile -t tillflow-pos:local .
docker run --rm -p 3000:3000 tillflow-pos:local
```

## Repo layout

See the brief's required mono-repo layout, reproduced as-built in
`docs/architecture.md`. Short version:

```
services/    pos (tenant setup live), payments, commission, web, _shared
infra/       Terraform: bootstrap (applied) + main stack (VPC/ECS/ALB/ECR/API GW/RDS — all applied)
.github/     CI (checks + real terraform plan) + deploy-pos + infra-apply (manual-trigger)
docs/        ownership, architecture, ADRs, SLOs, threat model, production-readiness log
evidence/    per-area runtime proof (platform-delivery has a real naming/tag audit run)
```

## Gates

Tracked outside this repo for now; see `docs/ownership.md` and the ADRs for what's decided.
G0 (decide) and G1 (Terraform + golden path) are done. G2 (product): tenant setup is live
and tested; sale recording, Daraja/Payments, and Commission are next.

## Cost / cleanup

Everything applied so far has real, ongoing cost: NAT gateway, ALB, one small ECS Fargate
task, and now RDS (`db.t4g.micro`) — on the order of tens of USD/month combined if left
running continuously. Tear down the main stack with `terraform -chdir=infra destroy` when
not actively working on it; `infra/bootstrap` (S3 + DynamoDB, near-zero cost) can stay up
indefinitely.
