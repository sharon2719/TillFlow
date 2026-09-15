-- Tenant setup: tenants, attendants (tenant-scoped roles), tills (commission rate lives
-- here, per docs/adr/0007), and the API keys that resolve every subsequent request to
-- exactly one tenant_id + role (docs/adr/0007's validation-boundary mechanism).
--
-- IDs are generated in application code (crypto.randomUUID()), not via a DB default -
-- keeps this schema free of extension dependencies (no pgcrypto) and portable to pg-mem
-- for tests.

CREATE SCHEMA IF NOT EXISTS pos;

CREATE TABLE IF NOT EXISTS pos.tenants (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pos.attendants (
  id         UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES pos.tenants (id),
  name       TEXT NOT NULL,
  msisdn     TEXT,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'attendant')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendants_tenant ON pos.attendants (tenant_id);

CREATE TABLE IF NOT EXISTS pos.tills (
  id                   UUID PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES pos.tenants (id),
  name                 TEXT NOT NULL,
  -- basis points: 500 = 5.00%. Integer, never floating point, same rule as money itself.
  commission_rate_bps  INTEGER NOT NULL CHECK (commission_rate_bps >= 0 AND commission_rate_bps <= 10000),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tills_tenant ON pos.tills (tenant_id);

CREATE TABLE IF NOT EXISTS pos.api_keys (
  id           UUID PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES pos.tenants (id),
  attendant_id UUID NOT NULL REFERENCES pos.attendants (id),
  -- sha256 hex digest of the raw key. The raw key itself is never stored anywhere.
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON pos.api_keys (key_hash);
