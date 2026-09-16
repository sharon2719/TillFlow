import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";

describe("payments API", () => {
  const app = createApp();

  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("POST /api/v1/payments/stk accepts a valid payment and preserves idempotency", async () => {
    const payload = {
      tenantId: "tenant-123",
      saleId: "sale-001",
      msisdn: "254700000001",
      amountMinorUnits: 2500,
      accountReference: "TillFlow",
      idempotencyKey: "pay-1",
    };

    const res = await request(app).post("/api/v1/payments/stk").send(payload);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "pending",
      tenantId: "tenant-123",
      saleId: "sale-001",
      amountMinorUnits: 2500,
    });
    expect(res.body.checkoutRequestId).toBeTruthy();
  });

  it("POST /api/v1/payments/stk rejects duplicate idempotency", async () => {
    const payload = {
      tenantId: "tenant-123",
      saleId: "sale-002",
      msisdn: "254700000002",
      amountMinorUnits: 3000,
      accountReference: "TillFlow",
      idempotencyKey: "pay-duplicate",
    };

    const first = await request(app).post("/api/v1/payments/stk").send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/v1/payments/stk").send(payload);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/idempotency/i);
  });

  it("POST /api/v1/payments/callback transitions a pending payment to completed", async () => {
    const create = await request(app).post("/api/v1/payments/stk").send({
      tenantId: "tenant-123",
      saleId: "sale-003",
      msisdn: "254700000003",
      amountMinorUnits: 5200,
      accountReference: "TillFlow",
      idempotencyKey: "pay-callback",
    });

    const checkoutRequestId = create.body.checkoutRequestId;

    const callback = await request(app)
      .post("/api/v1/payments/callback")
      .send({
        checkoutRequestId,
        status: "completed",
        resultCode: "0",
        resultDescription: "Success",
      });

    expect(callback.status).toBe(200);
    expect(callback.body).toMatchObject({
      status: "completed",
      checkoutRequestId,
    });
  });

  it("POST /api/v1/payments/b2c creates a payout and rejects invalid requests", async () => {
    const valid = await request(app).post("/api/v1/payments/b2c").send({
      tenantId: "tenant-123",
      payoutId: "payout-1",
      msisdn: "254700000004",
      amountMinorUnits: 1500,
      idempotencyKey: "payout-1",
    });

    expect(valid.status).toBe(201);
    expect(valid.body.status).toBe("pending");

    const invalid = await request(app).post("/api/v1/payments/b2c").send({
      tenantId: "tenant-123",
      payoutId: "payout-2",
      msisdn: "254700000005",
      amountMinorUnits: -1,
      idempotencyKey: "payout-2",
    });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/amount/i);
  });
});
