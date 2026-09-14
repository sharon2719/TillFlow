# ADR-0003: RDS PostgreSQL configuration

## Status
Proposed — 2026-09-14 (finalize instance sizing against k6 capacity results before G3).

## Context
POS, Payments and Commission each need durable relational state (sales, payment/payout
ledgers) with strict per-service isolation, on a budget appropriate for a capstone, sized
for a starting RPO target rather than production traffic.

## Decision
- **Engine:** PostgreSQL 16 on Amazon RDS (single instance, not Aurora — no need for
  Aurora's replica/storage-autoscaling story at this scale, and it keeps the ADR-defensible
  cost story simple).
- **Instance class:** `db.t4g.micro` to start (Graviton, burstable) — resized only if k6
  soak results in G3 show CPU credits exhausting under sustained load.
- **Storage:** 20 GiB gp3, provisioned IOPS left at default; revisit if the soak test shows
  I/O wait as the bottleneck.
- **Multi-AZ:** off for the capstone window (cost), documented as the first production
  hardening step in `docs/production-readiness.md` — this is a deliberate, disclosed
  trade-off, not an oversight.
- **Schema/role isolation:** one schema per service (`pos`, `payments`, `commission`) inside
  a single database, one least-privilege IAM-authenticated role per service, no
  cross-schema grants. A service's role can only touch its own schema.
- **Connection pooling:** RDS Proxy in front of the instance, one proxy endpoint per
  service role, so short-lived Fargate tasks don't exhaust `max_connections` under scale-out.
- **Backups:** automated backups, 7-day retention, backup window 02:00–03:00 EAT
  (00:00–01:00 UTC), chosen to sit outside the 06:30 EAT commission-payout SLO window.
  This ties directly to the RPO: at most ~24h of data loss from a point-in-time restore,
  which is acceptable because every sale and payout is independently re-derivable from the
  Daraja transaction query API during reconciliation (see the Recovery decision in
  `docs/slo-error-budgets.md`).

## Consequences
- No cross-service SQL joins — services that need each other's data go through their APIs,
  which is the correct boundary anyway (Commission must never read Payments' tables
  directly, only call its API).
- Single-AZ is a real availability risk, explicitly accepted and logged, not hidden.
