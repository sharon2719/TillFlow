# Architecture

## Request path

```
Public client
   │
   ▼
API Gateway (HTTP API, protocol_type = HTTP - not a REST API)
   │  VPC Link
   ▼
Internal ALB  (private subnets, two AZs), one listener, path-routed
   │
   ├──▶ pos          (default route - anything not matched below)
   ├──▶ payments      /api/v1/payments/*
   ├──▶ commission    /api/v1/commission/*   (real inbound HTTP API, not just a worker - see below)
   ├──▶ web           /  (BFF + minimal server-rendered UI, holds no DB of its own)
   └──▶ grafana       /grafana/*   (self-hosted, dashboards/datasources as code)

pos / payments / commission all read/write:
   ├─ RDS PostgreSQL   (single instance, schema-per-service, direct connection - no RDS Proxy)
   ├─ Secrets Manager  (DB creds, Daraja credentials, Slack webhook, Grafana admin password)
   └─ ADOT sidecar     (every backend task: app + collector container, OTLP -> CloudWatch/X-Ray)

pos additionally reads/writes ElastiCache (Redis) - a read-through cache in front of its
API-key auth lookup, the one DB round trip every authenticated request makes. Falls back to
a plain DB query on any Redis failure - never a hard dependency.

commission additionally consumes an SQS queue (+ DLQ) - a worker polling loop in the same
process as its HTTP server, started when COMMISSION_CLOSE_QUEUE_URL is set. An EventBridge
Scheduler fires a daily trigger message onto the queue; the worker records every trigger it
receives (commission.scheduled_runs). This is NOT a full cross-tenant sales-reconciliation
job - see "What this deliberately isn't" below.

payments owns every Daraja interaction: OAuth, STK Push, inbound STK/B2C callbacks,
transaction query/reconciliation. commission calls payments' HTTP API for B2C payouts -
never Daraja directly.

CloudWatch alarms on ALB/RDS metrics feed a separate EventBridge rule (not the alarms' own
native AlarmActions, which doesn't work on this account - see docs/scar-log.md), which
republishes to an SNS topic with email + a Slack-posting Lambda subscriber.
```

## Why this shape

- **API Gateway → VPC Link → ALB** keeps the ECS services in private subnets with no direct
  public exposure, while still getting API Gateway's throttling and edge features. It's an
  HTTP API (not a REST API) - cheaper and simpler for this project's needs (no request
  validation/transformation requirements that would justify a REST API's extra cost/features).
- **One ECS service per bounded context** (pos / payments / commission / web / grafana)
  instead of a single monolith service - each has its own SLO, its own scaling behavior, and
  its own failure blast radius. A Payments incident should not take down sale recording -
  proven, not just designed: `docs/recovery-drills.md`'s "Incident 1" is exactly a real
  Payments-only outage that left pos and commission unaffected.
- **Commission talks to Payments' API, never to Daraja** - this is a money-safety boundary,
  not a style preference: it means there is exactly one place in the system that can
  originate a real disbursement, which is what makes "replay must never double-pay"
  actually provable instead of asserted (`services/payments/test/payments.test.ts`,
  `services/commission/test/commission.test.ts`).
- **ADOT sidecar per task** - every backend task runs the application container plus an
  ADOT Collector container. The app exports OTLP to `localhost:4317` (the sidecar), which
  forwards metrics/traces to CloudWatch/Prometheus and X-Ray, and X-Ray feeds Grafana. This
  is defined once per task definition, not hand-wired per service.
- **No RDS Proxy.** A single small RDS instance with direct connections was judged
  sufficient at this project's real connection-pool scale (`pg.Pool`, max 5 per task,
  `desired_count=1` everywhere); RDS Proxy's main value (connection pooling/multiplexing at
  much higher concurrency, or graceful failover) doesn't pay for itself yet - tracked as a
  real trade-off, not an oversight, in `docs/production-readiness.md`.

## What this deliberately isn't

The SQS worker does NOT perform full cross-tenant sales reconciliation (aggregating every
tenant's paid sales for the day and calling `close` on their behalf automatically). That
would need a cross-service data source pos doesn't expose yet (this repo's schema-per-
service rule, `docs/adr/0003-database.md`, rules out a cross-service SQL join) and an
internal service-to-service auth mechanism this project's only auth model (tenant-scoped
API keys, `docs/adr/0007`) doesn't provide. The worker's real, narrower job - proving the
queue has a genuine consumer with real success/failure/DLQ-redrive behavior - is what G4's
recovery drills actually needed to exist; the full reconciliation feature is a disclosed,
not-yet-built follow-up (`services/commission/migrations/002_scheduled_runs.sql`,
`docs/production-readiness.md`).

## Multi-tenancy

Every table that holds tenant-owned data carries a `tenant_id` column, and every service
enforces tenant scoping at the query layer (never "trust the caller's claimed tenant"
without also checking it against the authenticated principal's tenant, resolved from the
API key alone - `docs/adr/0007`). Verified with an explicit cross-tenant isolation test, not
just asserted (`services/pos/test/tenants.test.ts`).

## Status

**Live in AWS and proven end to end, not just deployed** - every piece described above is
real: the full request path, all five ECS services, RDS, ElastiCache (consumed by pos),
SQS+DLQ+EventBridge (consumed by commission), Grafana, and the alarm delivery pipeline
(EventBridge bridge, not CloudWatch's native mechanism - see `docs/scar-log.md` for why).
See `docs/defence-prep.md` for the full verification walkthrough and `evidence/` for the
actual runtime proof behind each claim above, rather than repeating it here. This file is
kept current as the architecture changes; treat any mismatch between this doc and the repo
as a bug in this doc.
