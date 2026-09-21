# TillFlow

Multi-tenant POS + M-Pesa (Daraja) payments, on AWS ECS. Solo capstone build — see
`docs/ownership.md` for why every area still names one DRI even with a group of one.

## Status (2026-09-21)

**All gates (G0–G5) are done and live in AWS**, not just written up. The short version of
what's real, with pointers to the actual proof rather than a claim to take on faith:

- **G0/G1 (Decide/Platform):** VPC, ECS cluster running `pos`/`payments`/`commission`/`web`
  behind an internal ALB, an ADOT sidecar per task, ECR (SHA-tagged images only, no
  `latest`), a public API Gateway HTTP API, RDS, ElastiCache, SQS+DLQ+EventBridge. Real
  CI/CD: `.github/workflows/deploy-*.yml` build/push/migrate/deploy/smoke-test per service,
  `ci.yml` runs a real `terraform plan` on every PR via OIDC, `infra-apply.yml` applies on
  merge. Naming/tag and `latest`-tag compliance verified live, not from static review —
  `evidence/platform-delivery/`.
- **G2 (Product):** tenant setup, sale recording, Payments (real Daraja sandbox integration,
  STK + B2C both directions, real inbound callback observed live), and Commission (calls
  Payments over HTTP only, replay-safe, cannot double-pay) all proven end to end against the
  real deployed stack — `evidence/payments-integrity/`, `evidence/product-pos/`.
- **G3 (Operate):** self-hosted Grafana with real burn-rate/budget-remaining panels, an
  external synthetic probe (a plain scheduled Lambda — CloudWatch Synthetics genuinely
  cannot run in this account, confirmed by a real failed apply, see `docs/scar-log.md`), the
  full k6 suite (smoke/baseline/spike/15-min soak), and a capacity report built from real
  numbers, not estimates — `docs/capacity-report.md`.
- **G4 (Recover):** four documented drills, two of them found live rather than staged —
  `docs/recovery-drills.md`. Includes a real production incident (a rotated RDS credential
  silently crash-looping `payments`, caught by accident and fixed same-day) and a real
  broken-deploy scenario (a latent Terraform bug, also fixed, with the deployment circuit
  breaker's auto-rollback honestly left unresolved since it hadn't fired before manual
  intervention).
- **G5 (Release):** evidence pack, `docs/scar-log.md` (real mistakes, including three
  self-inflicted incidents from this session, not a sanitized list), `docs/defence-prep.md`,
  real AWS Cost Explorer data (`docs/cost-and-teardown.md`), and a fully live, end-to-end
  verified alerting pipeline — see below.

**Alerting works end to end, and getting there required finding and fixing a genuine
account-level bug**, not just wiring a Lambda. CloudWatch's native alarm→SNS mechanism
doesn't fire on this account for a reason that's still unexplained; alarms are now delivered
via an independent EventBridge rule instead (`infra/alarm-eventbridge-bridge.tf`), which
itself needed a second, separate fix (removing SNS encryption, isolated via a live
diagnostic). Verified by firing a real alarm and watching it reach Slack in seconds. Full
account in `docs/recovery-drills.md` drill 2 and `docs/scar-log.md`.

This README updated as each gate landed, not written once at the end — the git history is
the actual timeline.

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

Same pattern for `payments`, `commission`, and `web` (see each `services/<name>/package.json`).
`services/payments` additionally needs `DARAJA_*` env vars to use the real adapter instead of
the deterministic `FakeMpesaAdapter` — see `services/payments/.env.daraja.example`.

## Build a service image

```bash
docker build -f services/pos/Dockerfile -t tillflow-pos:local .
docker run --rm -p 3000:3000 tillflow-pos:local
```

## Load testing

`load-tests/` has the full k6 suite (smoke against real AWS, baseline/spike/soak against a
local stack so nothing hammers the real Daraja sandbox, plus a small real-sandbox contract
test) — see `docs/load-tests.md` for exactly how each was run and what it found.

## Repo layout

See the brief's required mono-repo layout, reproduced as-built in `docs/architecture.md`.
Short version:

```
services/    pos, payments, commission, web (all live in AWS), _shared
infra/       Terraform: bootstrap (applied) + main stack (VPC/ECS/ALB/ECR/API GW/RDS/
             ElastiCache/SQS/EventBridge/Grafana/alarms/EventBridge alert bridge — all applied)
load-tests/  full k6 suite: smoke, baseline, spike, soak, Daraja sandbox contract test
.github/     CI (checks + real terraform plan) + deploy-{pos,payments,commission,web,grafana}
             + infra-apply (manual-trigger)
docs/        ownership, architecture, ADRs, SLOs, threat model, runbook, recovery drills,
             capacity report, cost/teardown, scar log, defence prep, production-readiness log
evidence/    per-area runtime proof - real command output and live test results, not
             narrated claims
```

## Gates

All decided in `docs/ownership.md` and the ADRs, all closed out for real - see `docs/
defence-prep.md` for the full walkthrough (design, trade-offs, PRs, failure behavior, proof,
and a worked cross-system diagnosis) and `docs/scar-log.md` for what actually went wrong
along the way and what changed as a result.

## Cost / cleanup

Real Cost Explorer data (not an estimate), see `docs/cost-and-teardown.md` for the full
breakdown and methodology: TillFlow's own attributable cost is roughly **$48/day** at full
G1–G4 build-out, isolated from this shared account's ~$30/day pre-existing baseline (unrelated
resources that predate this repo). Top drivers: the NAT gateway, ECS Fargate compute across
five services, and the shared RDS instance. `terraform destroy` + reapply is documented and
ready but deliberately not run against the live demo stack until someone is actively watching
each step - see `docs/cost-and-teardown.md` for why and the exact plan. `infra/bootstrap`
(S3 + DynamoDB, near-zero cost) can stay up indefinitely regardless.
