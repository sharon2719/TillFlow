import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Queryable } from "../src/db.js";

const MIGRATION_SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "001_tenant_setup.sql"),
  "utf8",
);

function createTestDb(): Queryable {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.none(MIGRATION_SQL);
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

describe("tenant setup", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(createTestDb());
  });

  it("creates a tenant and returns a usable API key", async () => {
    const res = await request(app)
      .post("/tenants")
      .send({ name: "Acme Duka", ownerName: "Asha Owner" });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBeTruthy();
    expect(res.body.ownerAttendantId).toBeTruthy();
    expect(res.body.apiKey).toMatch(/^tfk_/);
  });

  it("rejects tenant creation with a missing name", async () => {
    const res = await request(app).post("/tenants").send({ ownerName: "Asha Owner" });
    expect(res.status).toBe(400);
  });

  it("lets the owner configure a till with the returned key", async () => {
    const created = await request(app)
      .post("/tenants")
      .send({ name: "Acme Duka", ownerName: "Asha Owner" });
    const apiKey = created.body.apiKey;

    const till = await request(app)
      .post("/tills")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ name: "Front counter", commissionRateBps: 500 });

    expect(till.status).toBe(201);
    expect(till.body.commissionRateBps).toBe(500);

    const list = await request(app).get("/tills").set("Authorization", `Bearer ${apiKey}`);
    expect(list.status).toBe(200);
    expect(list.body.tills).toHaveLength(1);
    expect(list.body.tills[0].name).toBe("Front counter");
  });

  it("rejects an invalid commission rate", async () => {
    const created = await request(app)
      .post("/tenants")
      .send({ name: "Acme Duka", ownerName: "Asha Owner" });
    const apiKey = created.body.apiKey;

    const res = await request(app)
      .post("/tills")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ name: "Front counter", commissionRateBps: 15000 });

    expect(res.status).toBe(400);
  });

  it("rejects requests with no API key", async () => {
    const res = await request(app).get("/tills");
    expect(res.status).toBe(401);
  });

  it("rejects requests with an unknown API key", async () => {
    const res = await request(app).get("/tills").set("Authorization", "Bearer tfk_not_a_real_key");
    expect(res.status).toBe(401);
  });

  it("lets an owner add an attendant, and that attendant cannot configure tills", async () => {
    const created = await request(app)
      .post("/tenants")
      .send({ name: "Acme Duka", ownerName: "Asha Owner" });
    const ownerKey = created.body.apiKey;

    const attendantRes = await request(app)
      .post("/attendants")
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ name: "Ben Attendant", role: "attendant" });
    expect(attendantRes.status).toBe(201);
    expect(attendantRes.body.apiKey).toMatch(/^tfk_/);

    const tillAttempt = await request(app)
      .post("/tills")
      .set("Authorization", `Bearer ${attendantRes.body.apiKey}`)
      .send({ name: "Front counter", commissionRateBps: 500 });
    expect(tillAttempt.status).toBe(403);

    // The attendant CAN still read tills, though - requireAuth alone, not requireOwner.
    const list = await request(app)
      .get("/tills")
      .set("Authorization", `Bearer ${attendantRes.body.apiKey}`);
    expect(list.status).toBe(200);
  });

  it("never lets one tenant see another tenant's tills", async () => {
    const tenantA = await request(app)
      .post("/tenants")
      .send({ name: "Tenant A", ownerName: "Owner A" });
    const tenantB = await request(app)
      .post("/tenants")
      .send({ name: "Tenant B", ownerName: "Owner B" });

    await request(app)
      .post("/tills")
      .set("Authorization", `Bearer ${tenantA.body.apiKey}`)
      .send({ name: "A's till", commissionRateBps: 100 });
    await request(app)
      .post("/tills")
      .set("Authorization", `Bearer ${tenantB.body.apiKey}`)
      .send({ name: "B's till", commissionRateBps: 200 });

    const asA = await request(app).get("/tills").set("Authorization", `Bearer ${tenantA.body.apiKey}`);
    expect(asA.body.tills).toHaveLength(1);
    expect(asA.body.tills[0].name).toBe("A's till");

    const asB = await request(app).get("/tills").set("Authorization", `Bearer ${tenantB.body.apiKey}`);
    expect(asB.body.tills).toHaveLength(1);
    expect(asB.body.tills[0].name).toBe("B's till");
  });
});
