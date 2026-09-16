-- Payments owns its own schema, isolated from pos's - no cross-service SQL joins
-- (docs/adr/0003-database.md). tenant_id here is a plain UUID, not a foreign key: the
-- tenants table lives in a different service's schema entirely.

CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE IF NOT EXISTS payments.stk_requests (
  id                  UUID PRIMARY KEY,
  tenant_id           UUID NOT NULL,
  sale_id             TEXT NOT NULL,
  msisdn              TEXT NOT NULL,
  amount_minor_units  BIGINT NOT NULL CHECK (amount_minor_units > 0),
  account_reference   TEXT NOT NULL,
  checkout_request_id TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  result_code         TEXT,
  result_description  TEXT,
  idempotency_key     TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_stk_requests_tenant ON payments.stk_requests (tenant_id);

CREATE TABLE IF NOT EXISTS payments.b2c_requests (
  id                 UUID PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  payout_id          TEXT NOT NULL,
  msisdn             TEXT NOT NULL,
  amount_minor_units BIGINT NOT NULL CHECK (amount_minor_units > 0),
  conversation_id    TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  result_code        TEXT,
  result_description TEXT,
  idempotency_key    TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_b2c_requests_tenant ON payments.b2c_requests (tenant_id);
