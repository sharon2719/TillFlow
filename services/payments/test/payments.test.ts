import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { FakeMpesaAdapter } from "@tillflow/shared";
import { newDb } from "pg-mem";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Queryable } from "../src/db.js";

const MIGRATION_SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "001_payments.sql"),
  "utf8",
);

function createTestDb(): Queryable {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.none(MIGRATION_SQL);
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

describe("payments API", () => {
  let app: ReturnType<typeof createApp>;
  let adapter: FakeMpesaAdapter;
  const tenantId = randomUUID();

  beforeEach(() => {
    adapter = new FakeMpesaAdapter();
    app = createApp(createTestDb(), adapter);
  });

  it("accepts an STK push and leaves it pending until the callback resolves it", async () => {
    const stk = await request(app).post("/api/v1/payments/stk").send({
      tenantId,
      saleId: "sale-1",
      msisdn: "254712345678",
      amountMinorUnits: 5000,
      accountReference: "sale-1",
      idempotencyKey: "idem-1",
    });
    expect(stk.status).toBe(201);
    expect(stk.body.status).toBe("pending");
    const { checkoutRequestId } = stk.body;

    const callback = await request(app).post("/api/v1/payments/callback").send({
      checkoutRequestId,
      resultCode: "0",
      resultDescription: "success",
    });
    expect(callback.status).toBe(200);
    expect(callback.body.status).toBe("completed");
  });

  it("rejects a duplicate idempotency key without creating a second charge", async () => {
    const payload = {
      tenantId,
      saleId: "sale-2",
      msisdn: "254712345678",
      amountMinorUnits: 1000,
      accountReference: "sale-2",
      idempotencyKey: "idem-dup",
    };
    const first = await request(app).post("/api/v1/payments/stk").send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/v1/payments/stk").send(payload);
    expect(second.status).toBe(409);
  });

  it("a timeout stays pending, is never treated as a decline, and a retry cannot create a second charge", async () => {
    const payload = {
      tenantId,
      saleId: "sale-3",
      msisdn: "254712345678",
      amountMinorUnits: 2500,
      accountReference: "sale-3",
      idempotencyKey: "idem-timeout",
      simulate: "timeout" as const,
    };

    const first = await request(app).post("/api/v1/payments/stk").send(payload);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("pending"); // not "failed" - the whole point

    // The client, having not received a timely result, retries with the SAME idempotency
    // key - this must not originate a second charge.
    const retry = await request(app).post("/api/v1/payments/stk").send(payload);
    expect(retry.status).toBe(409);
    expect(retry.body.checkoutRequestId).toBe(first.body.checkoutRequestId);

    // Querying while Daraja still hasn't resolved it: stays pending, not failed.
    const queryStillPending = await request(app).get(
      `/api/v1/payments/transactions/${first.body.checkoutRequestId}`,
    );
    expect(queryStillPending.body.status).toBe("pending");

    // The delayed result finally arrives (simulating the real callback/reconciliation
    // eventually resolving it) - reconciliation via query picks it up.
    adapter.simulateResolution(first.body.checkoutRequestId, "completed");
    const queryResolved = await request(app).get(`/api/v1/payments/transactions/${first.body.checkoutRequestId}`);
    expect(queryResolved.body.status).toBe("completed");
    expect(queryResolved.body.source).toBe("reconciled");

    // And the reconciled status is now persisted locally, not re-queried every time.
    const queryAgain = await request(app).get(`/api/v1/payments/transactions/${first.body.checkoutRequestId}`);
    expect(queryAgain.body.status).toBe("completed");
    expect(queryAgain.body.source).toBe("local");
  });

  it("a synchronous Daraja rejection is a real decline, distinct from a timeout", async () => {
    const res = await request(app).post("/api/v1/payments/stk").send({
      tenantId,
      saleId: "sale-4",
      msisdn: "254712345678",
      amountMinorUnits: 100,
      accountReference: "sale-4",
      idempotencyKey: "idem-reject",
      simulate: "reject",
    });
    expect(res.status).toBe(422);
  });

  it("a callback replay/reorder is a no-op the second time, not a second state change", async () => {
    const stk = await request(app).post("/api/v1/payments/stk").send({
      tenantId,
      saleId: "sale-5",
      msisdn: "254712345678",
      amountMinorUnits: 500,
      accountReference: "sale-5",
      idempotencyKey: "idem-replay",
    });
    const { checkoutRequestId } = stk.body;

    const first = await request(app)
      .post("/api/v1/payments/callback")
      .send({ checkoutRequestId, resultCode: "0", resultDescription: "success" });
    expect(first.body.status).toBe("completed");

    // Replayed callback claiming failure - must NOT flip an already-resolved payment.
    const replay = await request(app)
      .post("/api/v1/payments/callback")
      .send({ checkoutRequestId, resultCode: "1", resultDescription: "forced failure attempt" });
    expect(replay.body.status).toBe("completed");
    expect(replay.body.note).toMatch(/already resolved/i);
  });

  it("B2C: accepts a payout, resolves via callback, rejects a duplicate idempotency key", async () => {
    const payload = {
      tenantId,
      payoutId: "payout-1",
      msisdn: "254712345678",
      amountMinorUnits: 3000,
      idempotencyKey: "idem-b2c-1",
    };
    const first = await request(app).post("/api/v1/payments/b2c").send(payload);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("pending");

    const duplicate = await request(app).post("/api/v1/payments/b2c").send(payload);
    expect(duplicate.status).toBe(409);

    const callback = await request(app)
      .post("/api/v1/payments/b2c/callback")
      .send({ conversationId: first.body.conversationId, resultCode: "0", resultDescription: "success" });
    expect(callback.body.status).toBe("completed");
  });

  it("rejects invalid input", async () => {
    const res = await request(app).post("/api/v1/payments/stk").send({
      tenantId,
      saleId: "sale-6",
      msisdn: "not-a-real-number",
      amountMinorUnits: 100,
      accountReference: "sale-6",
      idempotencyKey: "idem-invalid",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/msisdn/i);
  });
});
