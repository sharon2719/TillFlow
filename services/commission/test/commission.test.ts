import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FakeMpesaAdapter } from "@tillflow/shared";
import { newDb } from "pg-mem";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { defaultB2cCaller } from "../src/commission.js";
import type { Queryable } from "../src/db.js";

const COMMISSION_MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "001_commission.sql"),
  "utf8",
);
const PAYMENTS_MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "payments", "migrations", "001_payments.sql"),
  "utf8",
);

function createPgMemDb(migrationSql: string): Queryable {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.none(migrationSql);
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

function createCommissionTestDb(): Queryable {
  return createPgMemDb(COMMISSION_MIGRATION);
}

/**
 * A real in-process Payments instance (its own pg-mem database, its own FakeMpesaAdapter),
 * not a mock of it - this is what actually proves Commission talks to Payments over real
 * HTTP, matching the brief's "requests B2C through the Payments API only" requirement,
 * rather than asserting it against a stand-in that could silently drift from the real
 * contract. Deliberately NOT importing payments' own singleton `app` - that one defaults to
 * a real (unconfigured) pg.Pool, which would try to connect to a real database that
 * doesn't exist in this test process.
 */
async function startRealPaymentsServer(): Promise<{ server: Server; url: string }> {
  const { createApp: createPaymentsApp } = await import("../../payments/src/app.js");
  const paymentsApp = createPaymentsApp(createPgMemDb(PAYMENTS_MIGRATION), new FakeMpesaAdapter());
  const server = createServer(paymentsApp);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe("commission close -> real Payments B2C call", () => {
  let paymentsServer: Server;
  let paymentsUrl: string;
  let app: ReturnType<typeof createApp>;
  const tenantId = randomUUID();

  beforeAll(async () => {
    const started = await startRealPaymentsServer();
    paymentsServer = started.server;
    paymentsUrl = started.url;
  });

  afterAll(() => {
    paymentsServer.close();
  });

  beforeEach(() => {
    app = createApp(createCommissionTestDb(), defaultB2cCaller(paymentsUrl));
  });

  it("pays out only confirmed-paid sales, via a real HTTP call to Payments", async () => {
    const res = await request(app)
      .post("/api/v1/commission/close")
      .set("Idempotency-Key", "close-1")
      .send({
        tenantId,
        businessDate: "2026-09-16",
        commissionRateBps: 500, // 5%
        sales: [
          { saleId: "sale-1", attendantId: "att-1", attendantMsisdn: "254712345678", totalMinorUnits: 10000, paymentStatus: "paid" },
          { saleId: "sale-2", attendantId: "att-2", attendantMsisdn: "254712345679", totalMinorUnits: 5000, paymentStatus: "pending" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.eligibleSales).toBe(1); // only the paid one
    expect(res.body.payouts).toHaveLength(1);
    expect(res.body.payouts[0].saleId).toBe("sale-1");
    expect(res.body.payouts[0].amountMinorUnits).toBe(500); // 5% of 10000
    expect(res.body.payouts[0].status).toBe("requested");
    expect(res.body.payouts[0].conversationId).toMatch(/^fake-conversation-/);
  });

  it("rejects a duplicate close without re-requesting B2C for the same sales", async () => {
    const payload = {
      tenantId,
      businessDate: "2026-09-16",
      commissionRateBps: 500,
      sales: [{ saleId: "sale-3", attendantId: "att-3", attendantMsisdn: "254712345680", totalMinorUnits: 2000, paymentStatus: "paid" as const }],
    };

    const first = await request(app).post("/api/v1/commission/close").set("Idempotency-Key", "close-2").send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/v1/commission/close").set("Idempotency-Key", "close-2").send(payload);
    expect(second.status).toBe(409);
  });

  it("never double-pays the same sale even when retried under a DIFFERENT idempotency key", async () => {
    const payload = {
      tenantId,
      businessDate: "2026-09-17",
      commissionRateBps: 1000,
      sales: [{ saleId: "sale-4", attendantId: "att-4", attendantMsisdn: "254712345681", totalMinorUnits: 4000, paymentStatus: "paid" as const }],
    };

    const first = await request(app).post("/api/v1/commission/close").set("Idempotency-Key", "close-3a").send(payload);
    expect(first.status).toBe(201);
    expect(first.body.payouts[0].status).toBe("requested");
    const firstConversationId = first.body.payouts[0].conversationId;

    // A different close, different idempotency key, but the SAME underlying sale - this is
    // exactly the scenario the sale-scoped b2c idempotency key (not the close's own key)
    // exists to guard against.
    const second = await request(app).post("/api/v1/commission/close").set("Idempotency-Key", "close-3b").send(payload);
    expect(second.status).toBe(201);
    expect(second.body.payouts[0].note).toMatch(/already paid out/i);
    expect(second.body.payouts[0].conversationId).toBe(firstConversationId);
  });

  it("rejects invalid input", async () => {
    const res = await request(app)
      .post("/api/v1/commission/close")
      .set("Idempotency-Key", "close-invalid")
      .send({ tenantId, businessDate: "not-a-date", commissionRateBps: 500, sales: [] });
    expect(res.status).toBe(400);
  });

  it("requires an Idempotency-Key", async () => {
    const res = await request(app)
      .post("/api/v1/commission/close")
      .send({ tenantId, businessDate: "2026-09-18", commissionRateBps: 500, sales: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idempotency/i);
  });
});
