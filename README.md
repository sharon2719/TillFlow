# TillFlow

TillFlow is a multi-tenant point-of-sale platform with M-Pesa payments, commission
payouts, and operational recovery evidence. It runs on AWS ECS Fargate in `eu-west-1`.

The project follows this delivery loop:

```text
Decide -> Design -> Plan -> Review -> Apply -> Prove -> Release -> Recover
```

The repository is deliberately evidence-led. A gate is not marked complete until its
blocking check has been executed and captured in `evidence/` or the linked operational
documentation.

## Current gate status

The repo follows an evidence-first gate model: a gate is only marked PASS once its required
proof is captured and committed. All gates G0–G5 are now PASS.

| Gate | Status | Blocking evidence |
|---|---|---|
| G0 | PASS | [ownership.md](docs/ownership.md), [threat-model.md](docs/threat-model.md) |
| G1 | PASS | [evidence/platform-delivery](evidence/platform-delivery), ADOT HEALTHY ordering, saved-plan apply |
| G2 | PASS | [evidence/payments-integrity/money-path-invariants-2026-09-18.md](evidence/payments-integrity/money-path-invariants-2026-09-18.md) |
| G3 | PASS | [alert-firing-recovery-2026-09-23.txt](evidence/reliability-operations/alert-firing-recovery-2026-09-23.txt), [sale-payment-callback-trace-2026-09-24.md](evidence/payments-integrity/sale-payment-callback-trace-2026-09-24.md), [commission-trace-2026-09-24.md](evidence/payments-integrity/commission-trace-2026-09-24.md) |
| G4 | PASS | [callback-replay-reorder-drill-2026-09-24.md](evidence/payments-integrity/callback-replay-reorder-drill-2026-09-24.md), [dlq-redrive-drill-2026-09-24.md](evidence/reliability-operations/dlq-redrive-drill-2026-09-24.md) |
| G5 | PASS | [g5-destroy-rebuild-2026-09-28.txt](evidence/platform-delivery/g5-destroy-rebuild-2026-09-28.txt) — destroy (215 resources) + rebuild (203 resources) + HTTP 200 at 18:17:19Z |

**Status rule:** do not mark any gate `PASS` until its dated evidence file exists, is
committed under `evidence/`, linked from the relevant README or gate document, and proves
the complete requested flow. Capture and document the real evidence before changing gate
status.

## Repository conventions

This repo follows the same capstone conventions expected in a final defence handoff:

- named ownership per area via [docs/ownership.md](docs/ownership.md) and [CODEOWNERS](CODEOWNERS);
- evidence-led status tracking, with gate claims backed by committed artifacts under
  [evidence/](evidence/);
- reproducible operational wrappers in [infra/scripts](infra/scripts/);
- explicit review follow-up in [docs/all-gates-review-follow-up.md](docs/all-gates-review-follow-up.md);
- known risk tracking in [docs/production-readiness.md](docs/production-readiness.md).

## Mission and acceptance bar

TillFlow must demonstrate more than a deployed web page. The acceptance bar is:

- private ECS services can be reached through the public API Gateway path;
- sales, payments, callbacks, and commission payouts preserve money-flow invariants;
- replay and timeout behavior cannot create a second payment or payout;
- an operator can detect, diagnose, recover, and prove a failure;
- an approved Terraform plan is the exact plan that gets applied;
- the workload can eventually be destroyed and rebuilt from the repository.

## Architecture

```text
Public client
    |
    v
API Gateway HTTP API
    | VPC Link
    v
Internal Application Load Balancer
    |
    +--> pos        default route
    +--> payments   /api/v1/payments/*
    +--> commission /api/v1/commission/*
    +--> web        /
    +--> grafana    /grafana/*

pos, payments, commission
    +--> PostgreSQL RDS, schema per service
    +--> Secrets Manager
    +--> ADOT collector sidecar -> CloudWatch and X-Ray

pos        +--> ElastiCache Redis read-through auth cache
commission +--> SQS queue + DLQ <- EventBridge Scheduler
payments   +--> Daraja OAuth, STK, B2C, callbacks, and reconciliation
```

All five ECS services run in private subnets with no public task IPs. The ALB is the
single application entry point behind API Gateway. Commission calls Payments over HTTP;
it does not call Daraja directly. This keeps real disbursement behavior in one bounded
context and makes replay safety testable.

See [architecture.md](docs/architecture.md) for the full request path, trade-offs, and
deliberate non-goals.

## Repository map

```text
services/
  _shared/       shared types, errors, logging, and test helpers
  pos/           tenant, auth, and sale recording
  payments/      Daraja integration, payment state, callbacks, reconciliation
  commission/    payout API and scheduled queue worker
  web/           server-rendered BFF and POS interface
  grafana/       dashboards and datasource provisioning

infra/           Terraform for the AWS workload
infra/bootstrap/ separate remote-state bootstrap stack
load-tests/      k6 smoke, baseline, spike, soak, and Daraja contract tests
docs/            architecture, ADRs, runbooks, drills, SLOs, and decisions
evidence/        captured runtime output and verification records
.github/workflows/ CI, security scans, deploy workflows, and gated infra apply
```

## Ownership

Every primary area has one named DRI, while cross-review is required before a gate closes.

| Area | DRI | Responsibility |
|---|---|---|
| Product and POS | sharon2719 | tenant model, frontend flow, sales, contracts |
| Payments and integrity | Gatchang-nyawargak | Daraja, callbacks, idempotency, replay, payouts |
| Platform and delivery | sharon2719 | Terraform, IAM, ECS, data services, CI/CD |
| Reliability and operations | sharon2719 | SLOs, telemetry, alerts, drills, runbooks |

Gatchang-nyawargak also authored the original sale-recording implementation in
`services/pos/src/sales.ts`; sharon2719 is DRI of record for Product and POS.

See [ownership.md](docs/ownership.md) for the contribution history, cross-review rule,
and CODEOWNERS details.

## Prerequisites

- Node.js 22 and npm 10+
- Docker
- Terraform 1.9+
- AWS credentials for `eu-west-1`
- k6 for load-test execution

## Local development

Install dependencies and run the checks for a service:

```bash
npm install
npm run typecheck --workspace=@tillflow/pos
npm run test --workspace=@tillflow/pos
npm run dev --workspace=@tillflow/pos
```

The POS health endpoint is available at `http://localhost:3000/health`. The same commands
work for `payments`, `commission`, and `web`; use each service's `package.json` for its
port and required environment. Payments needs the `DARAJA_*` variables from
`services/payments/.env.daraja.example` when using the real adapter.

## Infrastructure workflow

The backend is bootstrapped once, separately from the workload stack:

```bash
cd infra/bootstrap
terraform init
terraform apply
terraform output
```

Copy the backend outputs into `infra/backend.tf`, then initialize the main stack:

```bash
cd infra
terraform init
terraform plan -out=tfplan
terraform show -no-color tfplan
terraform apply tfplan
```

For GitHub Actions, pull requests run a real Terraform plan and fail-closed security
scans. The manually triggered infrastructure workflow creates a saved plan artifact,
waits at the `infra-apply` environment boundary, and applies that exact plan. It does
not generate a fresh plan with `-auto-approve`.

Service deploy workflows build immutable commit-SHA images, push them to ECR, run any
required migration, update ECS, and verify the public endpoint. `latest` is not an
accepted release tag.

## Verification and evidence

The most useful starting points are:

- [Money-path invariants](evidence/payments-integrity/money-path-invariants-2026-09-18.md)
- [Daraja sandbox verification](evidence/payments-integrity/daraja-sandbox-verification-2026-09-16.md)
- [POS API verification](evidence/product-pos/pos-api-verification-2026-09-18.md)
- [Recovery drills](docs/recovery-drills.md)
- [Capacity and load-test report](docs/capacity-report.md)
- [Production readiness](docs/production-readiness.md)
- [Scar log](docs/scar-log.md)
- [Defence preparation](docs/defence-prep.md)

Run the repository-level checks with:

```bash
npm run typecheck --workspace=@tillflow/pos
npm run test --workspace=@tillflow/pos
terraform fmt -check -recursive infra/
```

The k6 commands and their safety boundaries are documented in
[load-tests.md](docs/load-tests.md). The baseline, spike, and soak tests should not be
pointed at the live Daraja sandbox.

## Cost and teardown

The deployed stack costs roughly `$48/day` at the full G1-G4 footprint, separate from a
pre-existing shared-account baseline of roughly `$30/day`. The major drivers are the NAT
gateway, ECS Fargate, CloudWatch, RDS, and the shared ALB.

The workload destroy -> rebuild procedure is documented in
[cost-and-teardown.md](docs/cost-and-teardown.md), including the required pre-destroy
inventory, secret restoration, post-rebuild deployment, and wall-clock RTO measurement.
The remote-state bootstrap stack is separate and must remain outside workload teardown.

## Further reading

- [Architecture decisions](docs/adr/0001-tech-stack.md)
- [Threat model](docs/threat-model.md)
- [Runbook](docs/runbook.md)
- [SLOs and error budgets](docs/slo-error-budgets.md)
- [Release freeze policy](docs/release-freeze-policy.md)