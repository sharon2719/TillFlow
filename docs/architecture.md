# Architecture

## Request path

```
Web client
   │
   ▼
API Gateway (REST API)
   │  VPC Link
   ▼
Internal ALB  (private subnets, two AZs)
   │
   ├──▶ POS service         (ECS Fargate task: app + ADOT sidecar)
   ├──▶ Payments service    (ECS Fargate task: app + ADOT sidecar)
   └──▶ (Commission has no inbound HTTP route — it's a scheduled worker, see below)

POS / Payments / Commission all read/write:
   ├─ RDS PostgreSQL   (per-service schema + least-privilege role, via RDS Proxy)
   ├─ ElastiCache (Redis/Valkey)   (cache-aside; Payments also uses it for idempotency keys)
   ├─ SQS (+ DLQ)      (async work: commission calc, reconciliation retries)
   └─ Secrets Manager  (Daraja credentials, DB creds, Slack webhook)

Commission is triggered by an EventBridge daily schedule, calculates payouts from
confirmed-paid sales only, and calls the Payments service's internal API for B2C —
it never calls Daraja directly (see docs/adr — money-path ADRs to follow in G2).

Payments owns every Daraja interaction: OAuth, STK Push, C2B/B2C callbacks,
transaction query, and reconciliation.
```

## Why this shape

- **API Gateway → VPC Link → ALB** keeps the ECS services in private subnets with no direct
  public exposure, while still getting API Gateway's throttling, request validation and
  usage-plan features at the edge.
- **One ECS service per bounded context** (pos / payments / commission / web) instead of a
  single monolith service — each has its own SLO, its own scaling behavior, and its own
  failure blast radius. A Payments incident should not take down sale recording.
- **Commission talks to Payments' API, never to Daraja** — this is a money-safety boundary,
  not a style preference: it means there is exactly one place in the system that can
  originate a real disbursement, which is what makes "replay must never double-pay"
  actually provable instead of asserted.
- **ADOT sidecar per task** — every backend task runs the application container plus an
  ADOT Collector container. The app exports OTLP to `localhost:4317` (the sidecar), which
  forwards metrics/traces to CloudWatch/Prometheus and X-Ray, and X-Ray feeds Grafana.
  This is defined once per task definition, not hand-wired per service.

## Multi-tenancy

Every table that holds tenant-owned data carries a `tenant_id` column, and every service
enforces tenant scoping at the query layer (never "trust the caller's claimed tenant"
without also checking it against the authenticated principal's tenant). This is the
validation boundary the Product + POS area owns and will need explicit tests for — the
brief calls out contracts and validation boundaries specifically as owned decisions.

## Status

As of 2026-09-15: the request path above (API Gateway -> VPC Link -> ALB -> ECS Fargate,
app + ADOT sidecar) is written in Terraform, validated, and `plan`'d clean against real AWS
(37 resources), but not yet `apply`'d in this environment. `services/pos` still only has
`/health` and `/ready` — no database, no Daraja integration, and the ADOT sidecar boots
alongside it but pos doesn't emit real OTLP telemetry yet (that's separate OTel SDK work,
not yet done). Payments, Commission, Web, and RDS/ElastiCache/SQS/EventBridge are still to
be built — those get added to `infra/` once a service actually needs them, same pattern as
`_shared`. This file is kept current as each piece lands; treat any mismatch between this
doc and the repo as a bug in this doc.
