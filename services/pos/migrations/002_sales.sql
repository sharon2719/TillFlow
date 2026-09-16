-- Sale recording. A sale belongs to exactly one till (which carries the commission rate
-- Commission will use later) and is idempotent per (tenant, idempotency key) - the brief's
-- "idempotency prevents duplicate creation" requirement, enforced by the database itself
-- via a unique constraint, not just application-level bookkeeping that a redeploy or a
-- second task instance could silently lose.

CREATE TABLE IF NOT EXISTS pos.sales (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES pos.tenants (id),
  attendant_id      UUID NOT NULL REFERENCES pos.attendants (id),
  till_id           UUID NOT NULL REFERENCES pos.tills (id),
  total_minor_units BIGINT NOT NULL CHECK (total_minor_units >= 0),
  idempotency_key   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sales_tenant ON pos.sales (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_till ON pos.sales (till_id);

CREATE TABLE IF NOT EXISTS pos.sale_items (
  id                     UUID PRIMARY KEY,
  sale_id                UUID NOT NULL REFERENCES pos.sales (id),
  sku                    TEXT NOT NULL,
  quantity               INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor_units BIGINT NOT NULL CHECK (unit_price_minor_units >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON pos.sale_items (sale_id);
