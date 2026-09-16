-- Commission's own schema, isolated from pos/payments (docs/adr/0003 - no cross-service SQL
-- joins). This ledger is a distinct record from payments.b2c_requests: this table is
-- Commission's own decision ("why/when did we decide to pay this attendant this amount"),
-- payments' table is the actual M-Pesa transaction attempt. Two different concerns, kept
-- in two different services' schemas on purpose.

CREATE SCHEMA IF NOT EXISTS commission;

CREATE TABLE IF NOT EXISTS commission.closes (
  id                 UUID PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  business_date      DATE NOT NULL,
  idempotency_key    TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_date, idempotency_key)
);

CREATE TABLE IF NOT EXISTS commission.payouts (
  id                     UUID PRIMARY KEY,
  close_id               UUID NOT NULL REFERENCES commission.closes (id),
  tenant_id              UUID NOT NULL,
  business_date          DATE NOT NULL,
  sale_id                TEXT NOT NULL,
  attendant_id           TEXT NOT NULL,
  attendant_msisdn       TEXT NOT NULL,
  amount_minor_units     BIGINT NOT NULL CHECK (amount_minor_units >= 0),
  -- What Commission itself has decided/attempted, distinct from payments' own b2c status.
  status                 TEXT NOT NULL CHECK (status IN ('requested', 'b2c_call_failed')),
  b2c_idempotency_key    TEXT NOT NULL UNIQUE,
  b2c_conversation_id    TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payouts_close ON commission.payouts (close_id);
CREATE INDEX IF NOT EXISTS idx_payouts_tenant ON commission.payouts (tenant_id);

-- One payout per (tenant, business_date, sale) ever - a sale can only fund one commission
-- payout no matter how many times a close is retried with a different idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_unique_sale ON commission.payouts (tenant_id, business_date, sale_id);
