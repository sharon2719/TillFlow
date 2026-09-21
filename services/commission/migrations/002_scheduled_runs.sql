-- Records every daily-close trigger the SQS worker (src/worker.ts) actually receives and
-- processes, so a scheduled run is a real, observable event, not just a queue metric.
-- Deliberately NOT the full cross-tenant sales reconciliation (see infra/async.tf and
-- docs/production-readiness.md for why that's a separate, not-yet-built feature - it would
-- need a cross-service data source and an internal service-to-service auth mechanism that
-- don't exist yet, per docs/adr/0003's "no cross-service SQL joins" rule and docs/adr/0007's
-- tenant-scoped-API-key auth model). This table's job is narrower and honest about it: prove
-- the queue has a real consumer that can succeed, fail, and be retried/DLQ'd for real.

CREATE TABLE IF NOT EXISTS commission.scheduled_runs (
  id            UUID PRIMARY KEY,
  message_id    TEXT NOT NULL UNIQUE,
  action        TEXT NOT NULL,
  triggered_by  TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
