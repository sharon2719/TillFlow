# TillFlow

Multi-tenant POS + M-Pesa (Daraja) payments, on AWS ECS. Solo capstone build — see
`docs/ownership.md` for why every area still names one DRI even with a group of one.

## Status (2026-09-15)

`infra/bootstrap` is applied for real (state bucket + lock table exist in AWS). The main
`infra/` stack — VPC, ECS cluster/service/task-def with an ADOT sidecar, ALB, ECR, IAM
roles, and an API Gateway HTTP API + VPC Link in front of the ALB — is written, formatted,
validated, and `plan`'d clean (37 resources, 0 destroyed). It has not been `apply`'d yet in
this environment (infra applies are intentionally gated to a human decision here — see
`golden-path.tfplan` if present, or just re-run `terraform plan`). `.github/workflows/deploy-pos.yml`
builds `pos`, pushes it to ECR by commit SHA, registers a new ECS task definition revision,
updates the service, waits for stability, and smoke-tests the public API Gateway endpoint —
this is G1's "first pipeline deploy," pending the infra apply to actually run against.
RDS/ElastiCache/SQS aren't stood up yet since no service needs them until Payments/Commission
exist. This README updates as each gate lands, not written once at the end.

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
services/    pos, payments, commission, web, _shared
infra/       Terraform: bootstrap (applied) + main stack (VPC/ECS/ALB/ECR/API GW — plan'd, not applied)
.github/     CI (checks) + deploy-pos (build/push/deploy/smoke-test pipeline)
docs/        ownership, architecture, ADRs, SLOs, threat model
evidence/    per-area runtime proof (empty placeholders for now)
```

## Gates

Tracked outside this repo for now; see `docs/ownership.md` and the ADRs for what's decided.
G0 (decide) is done. G1 (Terraform + golden path): network + ECS golden path Terraform is
written and `plan`'d clean; the deploy pipeline exists; the actual `apply` against AWS and
the first real pipeline run are the remaining steps.

## Cost / cleanup

`infra/bootstrap` is live (S3 + DynamoDB, effectively free at this scale). The main stack
(VPC, NAT gateway, ALB, ECS Fargate task) has real hourly cost once applied — roughly a NAT
gateway + ALB + one small Fargate task, on the order of tens of USD/month if left running
continuously. Tear down with `terraform -chdir=infra destroy` when not actively working on
it; `infra/bootstrap` can stay up indefinitely (near-zero idle cost).
