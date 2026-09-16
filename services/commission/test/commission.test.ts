import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";

describe("commission close", () => {
  const app = createApp();

  it("creates payouts only from paid sales", async () => {
    const res = await request(app)
      .post("/api/v1/commission/close")
      .set("Idempotency-Key", "close-1")
      .send({
        tenantId: "tenant-1",
        businessDate: "2026-09-16",
        commissionRateBps: 500,
        sales: [
          { saleId: "sale-paid", attendantId: "a-1", attendantMsisdn: "254700000001", totalMinorUnits: 10000, paymentStatus: "paid" },
          { saleId: "sale-pending", attendantId: "a-1", attendantMsisdn: "254700000001", totalMinorUnits: 9000, paymentStatus: "pending" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.eligibleSales).toBe(1);
    expect(res.body.payouts[0]).toMatchObject({ amountMinorUnits: 500, status: "requested" });
  });

  it("rejects replay of the same close", async () => {
    const payload = { tenantId: "tenant-2", businessDate: "2026-09-16", commissionRateBps: 1000, sales: [] };
    const first = await request(app).post("/api/v1/commission/close").set("Idempotency-Key", "close-replay").send(payload);
    const second = await request(app).post("/api/v1/commission/close").set("Idempotency-Key", "close-replay").send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });
});
