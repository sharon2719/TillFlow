import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Queryable } from "../src/db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION_SQL = ["001_tenant_setup.sql", "002_sales.sql"]
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

function createTestDb(): Queryable {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.none(MIGRATION_SQL);
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

/** Bootstraps a tenant + owner key, then configures one till, returning both. */
async function setUpTenantWithTill(app: ReturnType<typeof createApp>) {
  const tenant = await request(app)
    .post("/tenants")
    .send({ name: "Acme Duka", ownerName: "Asha Owner" });
  const ownerKey = tenant.body.apiKey as string;

  const till = await request(app)
    .post("/tills")
    .set("Authorization", `Bearer ${ownerKey}`)
    .send({ name: "Front counter", commissionRateBps: 500 });

  return { ownerKey, tillId: till.body.tillId as string, tenantId: tenant.body.tenantId as string };
}

describe("POS sales API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(createTestDb());
  });

  it("creates a sale for the authenticated tenant, deriving tenantId/attendantId from the API key", async () => {
    const { ownerKey, tillId, tenantId } = await setUpTenantWithTill(app);

    const res = await request(app)
      .post("/api/v1/sales")
      .set("Authorization", `Bearer ${ownerKey}`)
      .set("Idempotency-Key", "sale-1")
      .send({
        tillId,
        items: [
          { sku: "sku-001", quantity: 2, unitPriceMinorUnits: 2500 },
          { sku: "sku-002", quantity: 1, unitPriceMinorUnits: 1500 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(tenantId);
    expect(res.body.totalMinorUnits).toBe(6500);
    expect(res.body.status).toBe("recorded");
    expect(res.body.saleId).toBeTruthy();
  });

  it("rejects a sale with no Authorization header", async () => {
    const { tillId } = await setUpTenantWithTill(app);
    const res = await request(app)
      .post("/api/v1/sales")
      .set("Idempotency-Key", "sale-1")
      .send({ tillId, items: [{ sku: "sku-001", quantity: 1, unitPriceMinorUnits: 100 }] });
    expect(res.status).toBe(401);
  });

  it("rejects a sale with no Idempotency-Key header", async () => {
    const { ownerKey, tillId } = await setUpTenantWithTill(app);
    const res = await request(app)
      .post("/api/v1/sales")
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ tillId, items: [{ sku: "sku-001", quantity: 1, unitPriceMinorUnits: 100 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idempotency/i);
  });

  it("rejects a duplicate idempotency key without creating a second sale", async () => {
    const { ownerKey, tillId } = await setUpTenantWithTill(app);
    const payload = { tillId, items: [{ sku: "sku-003", quantity: 1, unitPriceMinorUnits: 1000 }] };

    const first = await request(app)
      .post("/api/v1/sales")
      .set("Authorization", `Bearer ${ownerKey}`)
      .set("Idempotency-Key", "duplicate-check")
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/sales")
      .set("Authorization", `Bearer ${ownerKey}`)
      .set("Idempotency-Key", "duplicate-check")
      .send({ tillId, items: [{ sku: "sku-004", quantity: 2, unitPriceMinorUnits: 2000 }] });

    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/idempotency/i);
  });

  it("rejects an invalid item (non-positive quantity)", async () => {
    const { ownerKey, tillId } = await setUpTenantWithTill(app);
    const res = await request(app)
      .post("/api/v1/sales")
      .set("Authorization", `Bearer ${ownerKey}`)
      .set("Idempotency-Key", "sale-invalid")
      .send({ tillId, items: [{ sku: "sku-005", quantity: 0, unitPriceMinorUnits: 1000 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/quantity/i);
  });

  it("rejects a tillId that belongs to a different tenant", async () => {
    const tenantA = await setUpTenantWithTill(app);
    const tenantB = await setUpTenantWithTill(app);

    const res = await request(app)
      .post("/api/v1/sales")
      .set("Authorization", `Bearer ${tenantA.ownerKey}`)
      .set("Idempotency-Key", "cross-tenant-attempt")
      .send({
        tillId: tenantB.tillId, // someone else's till
        items: [{ sku: "sku-006", quantity: 1, unitPriceMinorUnits: 500 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/till/i);
  });

  it("scopes GET /api/v1/sales/:id to the authenticated tenant", async () => {
    const tenantA = await setUpTenantWithTill(app);
    const tenantB = await setUpTenantWithTill(app);

    const created = await request(app)
      .post("/api/v1/sales")
      .set("Authorization", `Bearer ${tenantA.ownerKey}`)
      .set("Idempotency-Key", "sale-read-scope")
      .send({ tillId: tenantA.tillId, items: [{ sku: "sku-007", quantity: 1, unitPriceMinorUnits: 100 }] });

    const asOwner = await request(app)
      .get(`/api/v1/sales/${created.body.saleId}`)
      .set("Authorization", `Bearer ${tenantA.ownerKey}`);
    expect(asOwner.status).toBe(200);

    const asOtherTenant = await request(app)
      .get(`/api/v1/sales/${created.body.saleId}`)
      .set("Authorization", `Bearer ${tenantB.ownerKey}`);
    expect(asOtherTenant.status).toBe(404);
  });
});
