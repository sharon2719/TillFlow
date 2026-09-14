# TillFlow

Multi-tenant POS + M-Pesa (Daraja) payments, on AWS ECS. Solo capstone build — see
`docs/ownership.md` for why every area still names one DRI even with a group of one.

## Status (2026-09-14)

Working: `services/pos` health/readiness skeleton (tested, Dockerized), and a validated
Terraform foundation (`infra/`) — VPC across two AZs, public/private subnets, NAT, plus a
one-time `infra/bootstrap` stack for the remote-state bucket + lock table. Nothing has been
`apply`'d to AWS yet (no account/credentials wired in this environment). ECS, RDS,
ElastiCache, SQS and the pipeline are next. This README updates as each gate lands, not
written once at the end.

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
infra/       Terraform: bootstrap (state backend) + main stack (VPC done, ECS/RDS/etc next)
.github/     CI: pos build/test, terraform fmt+validate, Trivy secret/dep/IaC scan
docs/        ownership, architecture, ADRs, SLOs, threat model
evidence/    per-area runtime proof (empty placeholders for now)
```

## Gates

Tracked outside this repo for now; see `docs/ownership.md` and the ADRs for what's decided.
G0 (decide) is done. G1 (Terraform + golden path) is in progress: network layer validated,
ECS/RDS/ElastiCache/SQS/pipeline still to come.

## Cost / cleanup

Nothing deployed to AWS yet — no cost, nothing to tear down.
