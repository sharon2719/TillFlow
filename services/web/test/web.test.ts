import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import type { WebConfig } from "../src/config.js";

const config: WebConfig = {
  posApiUrl: "http://pos.test",
  paymentsApiUrl: "http://payments.test",
  commissionApiUrl: "http://commission.test",
  sessionSecret: "test-secret",
};

const TILL = { id: "till-1", name: "Main Till", commission_rate_bps: 500 };
const SALE = {
  saleId: "sale-1",
  tenantId: "tenant-1",
  attendantId: "attendant-1",
  tillId: TILL.id,
  totalMinorUnits: 10000,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;

    if (url === "http://pos.test/tills" && method === "GET") {
      if (auth !== "Bearer valid-key") return json(401, { error: "invalid API key" });
      return json(200, { tills: [TILL] });
    }
    if (url === "http://pos.test/tills" && method === "POST") {
      return json(201, { tillId: "till-2" });
    }
    if (url === "http://pos.test/api/v1/sales" && method === "POST") {
      return json(201, SALE);
    }
    if (url === "http://payments.test/api/v1/payments/stk" && method === "POST") {
      return json(201, { checkoutRequestId: "checkout-1", status: "pending" });
    }
    if (url === "http://payments.test/api/v1/payments/transactions/checkout-1" && method === "GET") {
      return json(200, { status: "completed", resultCode: "0" });
    }
    if (url === "http://commission.test/api/v1/commission/close" && method === "POST") {
      return json(201, { payouts: [{ status: "requested", conversationId: "conv-1" }] });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function getCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies[0];
  if (!cookie) throw new Error("no Set-Cookie header in response");
  return cookie.split(";")[0];
}

describe("web", () => {
  it("exposes health endpoints", async () => {
    const app = createApp(config, makeFetch());
    await expect(request(app).get("/health")).resolves.toMatchObject({ status: 200 });
    await expect(request(app).get("/app/health")).resolves.toMatchObject({ status: 200 });
  });

  it("redirects an unauthenticated dashboard request to login", async () => {
    const app = createApp(config, makeFetch());
    const res = await request(app).get("/app/dashboard");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/app/login");
  });

  it("rejects an invalid API key at login", async () => {
    const app = createApp(config, makeFetch());
    const res = await request(app).post("/app/login").type("form").send({ apiKey: "wrong-key" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/app/login?error=1");
  });

  it("logs in with a valid key and renders the dashboard", async () => {
    const app = createApp(config, makeFetch());
    const login = await request(app).post("/app/login").type("form").send({ apiKey: "valid-key" });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe("/app/dashboard");
    const cookie = getCookie(login);

    const dashboard = await request(app).get("/app/dashboard").set("Cookie", cookie);
    expect(dashboard.status).toBe(200);
    expect(dashboard.text).toContain("Main Till");
  });

  it("escapes user-supplied till names instead of rendering them as HTML", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://pos.test/tills" && (init?.method ?? "GET") === "GET") {
        return json(200, { tills: [{ id: "t1", name: "<script>alert(1)</script>", commission_rate_bps: 0 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const app = createApp(config, fetchImpl);
    const login = await request(app).post("/app/login").type("form").send({ apiKey: "valid-key" });
    const cookie = getCookie(login);

    const dashboard = await request(app).get("/app/dashboard").set("Cookie", cookie);
    expect(dashboard.text).not.toContain("<script>alert(1)</script>");
    expect(dashboard.text).toContain("&lt;script&gt;");
  });

  it("carries a sale through payment request, status check, and commission close", async () => {
    const fetchImpl = makeFetch();
    const app = createApp(config, fetchImpl);
    const login = await request(app).post("/app/login").type("form").send({ apiKey: "valid-key" });
    const cookie = getCookie(login);

    const sale = await request(app)
      .post("/app/sales")
      .set("Cookie", cookie)
      .type("form")
      .send({ tillId: TILL.id, sku: "SKU1", quantity: "2", unitPriceMinorUnits: "5000" });
    expect(sale.status).toBe(200);
    expect(sale.text).toContain("sale-1");

    const stk = await request(app)
      .post("/app/payments/stk")
      .set("Cookie", cookie)
      .type("form")
      .send({
        tenantId: SALE.tenantId,
        saleId: SALE.saleId,
        attendantId: SALE.attendantId,
        tillId: SALE.tillId,
        totalMinorUnits: String(SALE.totalMinorUnits),
        commissionRateBps: "500",
        msisdn: "254712345678",
      });
    expect(stk.status).toBe(200);
    expect(stk.text).toContain("checkout-1");

    const status = await request(app)
      .post("/app/payments/status")
      .set("Cookie", cookie)
      .type("form")
      .send({
        checkoutRequestId: "checkout-1",
        tenantId: SALE.tenantId,
        saleId: SALE.saleId,
        attendantId: SALE.attendantId,
        tillId: SALE.tillId,
        totalMinorUnits: String(SALE.totalMinorUnits),
        commissionRateBps: "500",
        msisdn: "254712345678",
      });
    expect(status.status).toBe(200);
    expect(status.text).toContain("completed");
    expect(status.text).toContain("Close commission for this sale");

    const close = await request(app)
      .post("/app/commission/close")
      .set("Cookie", cookie)
      .type("form")
      .send({
        tenantId: SALE.tenantId,
        saleId: SALE.saleId,
        attendantId: SALE.attendantId,
        totalMinorUnits: String(SALE.totalMinorUnits),
        commissionRateBps: "500",
        attendantMsisdn: "254712345678",
        businessDate: "2026-01-01",
      });
    expect(close.status).toBe(200);
    expect(close.text).toContain("requested");
    expect(close.text).toContain("conv-1");

    const closeCall = fetchImpl.mock.calls.find(([url]) => url === "http://commission.test/api/v1/commission/close");
    expect(closeCall?.[1]?.headers).toMatchObject({ "Idempotency-Key": `web:close:${SALE.saleId}:2026-01-01` });
  });
});
