import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";

describe("POS sales API", () => {
  const app = createApp();

  it("POST /api/v1/sales creates a sale with an idempotent key", async () => {
    const payload = {
      tenantId: "tenant-123",
      attendantId: "attendant-456",
      items: [
        { sku: "sku-001", quantity: 2, unitPriceMinorUnits: 2500 },
        { sku: "sku-002", quantity: 1, unitPriceMinorUnits: 1500 },
      ],
    };

    const res = await request(app)
      .post("/api/v1/sales")
      .set("Idempotency-Key", "sale-1")
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tenantId: "tenant-123",
      attendantId: "attendant-456",
      totalMinorUnits: 6500,
      status: "recorded",
    });
    expect(res.body.saleId).toBeTruthy();
  });

  it("POST /api/v1/sales rejects a duplicate idempotency key", async () => {
    const payload = {
      tenantId: "tenant-123",
      attendantId: "attendant-456",
      items: [{ sku: "sku-003", quantity: 1, unitPriceMinorUnits: 1000 }],
    };

    const first = await request(app)
      .post("/api/v1/sales")
      .set("Idempotency-Key", "duplicate-check")
      .send(payload);

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/sales")
      .set("Idempotency-Key", "duplicate-check")
      .send({
        tenantId: "tenant-123",
        attendantId: "attendant-456",
        items: [{ sku: "sku-004", quantity: 2, unitPriceMinorUnits: 2000 }],
      });

    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/idempotency/i);
  });

  it("POST /api/v1/sales rejects an invalid request", async () => {
    const res = await request(app).post("/api/v1/sales").send({
      tenantId: "tenant-123",
      attendantId: "attendant-456",
      items: [{ sku: "sku-005", quantity: 0, unitPriceMinorUnits: 1000 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/quantity/i);
  });
});
