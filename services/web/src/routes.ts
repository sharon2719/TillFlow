import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

import { backendRequest, type FetchImpl } from "./backend.js";
import type { WebConfig } from "./config.js";
import { clearSessionCookieHeader, readSessionApiKey, sessionCookieHeader } from "./session.js";
import { esc, hidden, layout } from "./views.js";

declare module "express-serve-static-core" {
  interface Request {
    apiKey?: string;
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function errorCard(status: number, body: unknown): string {
  const message = (body as { error?: string })?.error ?? `request failed (${status})`;
  return `<p class="err">${esc(message)}</p><p><a href="/app/dashboard">Back to dashboard</a></p>`;
}

/**
 * web is a BFF, not a fourth source of truth: it holds no database, no sale/payment/payout
 * records of its own, and no server-side session store. Every fact shown here (till list,
 * sale total, payment status, payout status) is fetched fresh from pos/payments/commission
 * on each request; the only thing web itself carries between requests is the caller's own
 * signed-cookie API key (session.ts) and, within a single page-to-page flow, whatever
 * hidden form fields keep that flow's state (this replaces a client-side list of an
 * attendant's own sales, which pos doesn't expose an endpoint for yet - see README).
 */
export function createWebRouter(config: WebConfig, fetchImpl: FetchImpl = fetch): Router {
  const router = Router();

  router.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  // Also mounted under the path the ALB's listener rule actually routes here (/app/*, see
  // infra/alb.tf) - bare /health falls through to pos's default action otherwise.
  router.get("/app/health", (_req, res) => res.status(200).json({ status: "ok" }));

  router.get("/", (_req, res) => res.redirect("/app/login"));

  router.get("/app/login", (req, res) => {
    const error = req.query.error === "1";
    res.type("html").send(
      layout(
        "Sign in",
        `<form method="post" action="/app/login">
          <label for="apiKey">API key</label>
          <input id="apiKey" name="apiKey" type="password" required autofocus>
          ${error ? '<p class="err">Invalid API key.</p>' : ""}
          <button type="submit">Sign in</button>
        </form>
        <p class="muted">Get an API key from <code>POST /tenants</code> (new shop) or ask your owner for one.</p>`,
      ),
    );
  });

  router.post("/app/login", async (req, res) => {
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    if (!apiKey) {
      res.redirect("/app/login?error=1");
      return;
    }
    // Reuses GET /tills purely as an auth check - any authenticated role can call it, so a
    // 200 here only proves the key is real, nothing about role is implied by it.
    const check = await backendRequest(fetchImpl, config.posApiUrl, "/tills", { apiKey });
    if (check.status !== 200) {
      res.redirect("/app/login?error=1");
      return;
    }
    res.setHeader("Set-Cookie", sessionCookieHeader(apiKey, config.sessionSecret));
    res.redirect("/app/dashboard");
  });

  router.get("/app/logout", (_req, res) => {
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.redirect("/app/login");
  });

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const apiKey = readSessionApiKey(req.header("cookie"), config.sessionSecret);
    if (!apiKey) {
      res.redirect("/app/login");
      return;
    }
    req.apiKey = apiKey;
    next();
  };

  router.get("/app/dashboard", requireSession, async (req, res) => {
    const tills = await backendRequest<{ tills: { id: string; name: string; commission_rate_bps: number }[] }>(
      fetchImpl,
      config.posApiUrl,
      "/tills",
      { apiKey: req.apiKey },
    );
    if (tills.status !== 200) {
      res.type("html").send(layout("Dashboard", errorCard(tills.status, tills.body)));
      return;
    }

    const tillRows = tills.body.tills
      .map(
        (t) =>
          `<li>${esc(t.name)} - ${t.commission_rate_bps / 100}% commission <span class="muted">(${esc(t.id)})</span></li>`,
      )
      .join("");
    const tillOptions = tills.body.tills.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");

    res.type("html").send(
      layout(
        "Dashboard",
        `<nav><a href="/app/logout">Sign out</a></nav>
        <h2>Tills</h2>
        <ul>${tillRows || "<li><em>No tills yet</em></li>"}</ul>
        <form method="post" action="/app/tills">
          <label for="name">New till name</label>
          <input id="name" name="name" required>
          <label for="commissionRateBps">Commission rate (basis points, e.g. 500 = 5%)</label>
          <input id="commissionRateBps" name="commissionRateBps" type="number" min="0" max="10000" required>
          <button type="submit">Create till</button>
        </form>

        <h2>Record a sale</h2>
        <form method="post" action="/app/sales">
          <label for="tillId">Till</label>
          <select id="tillId" name="tillId" required>${tillOptions || '<option value="">No tills available</option>'}</select>
          <label for="sku">Item SKU</label>
          <input id="sku" name="sku" required>
          <label for="quantity">Quantity</label>
          <input id="quantity" name="quantity" type="number" min="1" value="1" required>
          <label for="unitPriceMinorUnits">Unit price (minor units, e.g. cents)</label>
          <input id="unitPriceMinorUnits" name="unitPriceMinorUnits" type="number" min="0" required>
          <button type="submit">Record sale</button>
        </form>`,
      ),
    );
  });

  router.post("/app/tills", requireSession, async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const commissionRateBps = Number(req.body?.commissionRateBps);
    const result = await backendRequest(fetchImpl, config.posApiUrl, "/tills", {
      method: "POST",
      apiKey: req.apiKey,
      body: { name, commissionRateBps },
    });
    if (result.status !== 201) {
      res.type("html").send(layout("Create till failed", errorCard(result.status, result.body)));
      return;
    }
    res.redirect("/app/dashboard");
  });

  router.post("/app/sales", requireSession, async (req, res) => {
    const tillId = typeof req.body?.tillId === "string" ? req.body.tillId : "";
    const sku = typeof req.body?.sku === "string" ? req.body.sku.trim() : "";
    const quantity = Number(req.body?.quantity);
    const unitPriceMinorUnits = Number(req.body?.unitPriceMinorUnits);

    const saleResult = await backendRequest<{
      saleId: string;
      tenantId: string;
      attendantId: string;
      tillId: string;
      totalMinorUnits: number;
    }>(fetchImpl, config.posApiUrl, "/api/v1/sales", {
      method: "POST",
      apiKey: req.apiKey,
      headers: { "Idempotency-Key": `web:sale:${randomUUID()}` },
      body: { tillId, items: [{ sku, quantity, unitPriceMinorUnits }] },
    });

    if (saleResult.status !== 201) {
      res.type("html").send(layout("Record sale failed", errorCard(saleResult.status, saleResult.body)));
      return;
    }
    const sale = saleResult.body;

    // Carries the till's own commission rate forward to the close step, so the owner
    // doesn't have to remember/retype it.
    const tills = await backendRequest<{ tills: { id: string; commission_rate_bps: number }[] }>(
      fetchImpl,
      config.posApiUrl,
      "/tills",
      { apiKey: req.apiKey },
    );
    const till = tills.body.tills?.find((t) => t.id === sale.tillId);
    const commissionRateBps = till?.commission_rate_bps ?? 0;

    res.type("html").send(
      layout(
        "Sale recorded",
        `<div class="card">
          <p class="ok">Sale recorded: ${esc(sku)} x ${esc(quantity)} = ${esc(sale.totalMinorUnits)} minor units.</p>
          <p class="muted">saleId: ${esc(sale.saleId)}</p>
        </div>
        <form method="post" action="/app/payments/stk">
          ${hidden("tenantId", sale.tenantId)}
          ${hidden("saleId", sale.saleId)}
          ${hidden("attendantId", sale.attendantId)}
          ${hidden("tillId", sale.tillId)}
          ${hidden("totalMinorUnits", sale.totalMinorUnits)}
          ${hidden("commissionRateBps", commissionRateBps)}
          <label for="msisdn">Customer phone (254XXXXXXXXX) to request payment from</label>
          <input id="msisdn" name="msisdn" pattern="254[0-9]{9}" required>
          <button type="submit">Request M-Pesa payment</button>
        </form>
        <p><a href="/app/dashboard">Back to dashboard</a></p>`,
      ),
    );
  });

  router.post("/app/payments/stk", requireSession, async (req, res) => {
    const { tenantId, saleId, attendantId, tillId, totalMinorUnits, commissionRateBps, msisdn } = req.body ?? {};

    const stk = await backendRequest<{ checkoutRequestId?: string; error?: string }>(
      fetchImpl,
      config.paymentsApiUrl,
      "/api/v1/payments/stk",
      {
        method: "POST",
        body: {
          tenantId,
          saleId,
          msisdn,
          amountMinorUnits: Number(totalMinorUnits),
          accountReference: saleId,
          // Stable per sale: resubmitting this form (e.g. a double click, or reloading this
          // page) is recognized as a retry of the same STK push, never a second charge -
          // the same guarantee proven in services/payments/test/payments.test.ts, exercised
          // here through the real HTTP path instead of pg-mem.
          idempotencyKey: `web:stk:${saleId}`,
        },
      },
    );

    if (stk.status !== 201 || !stk.body.checkoutRequestId) {
      res.type("html").send(layout("Payment request failed", errorCard(stk.status, stk.body)));
      return;
    }

    res.type("html").send(
      layout(
        "Payment requested",
        `<div class="card">
          <p>STK push sent to ${esc(msisdn)}.</p>
          <p class="muted">checkoutRequestId: ${esc(stk.body.checkoutRequestId)}</p>
        </div>
        <form method="post" action="/app/payments/status">
          ${hidden("checkoutRequestId", stk.body.checkoutRequestId)}
          ${hidden("tenantId", tenantId)}
          ${hidden("saleId", saleId)}
          ${hidden("attendantId", attendantId)}
          ${hidden("tillId", tillId)}
          ${hidden("totalMinorUnits", totalMinorUnits)}
          ${hidden("commissionRateBps", commissionRateBps)}
          ${hidden("msisdn", msisdn)}
          <button type="submit">Check payment status</button>
        </form>
        <p><a href="/app/dashboard">Back to dashboard</a></p>`,
      ),
    );
  });

  router.post("/app/payments/status", requireSession, async (req, res) => {
    const { checkoutRequestId, tenantId, saleId, attendantId, tillId, totalMinorUnits, commissionRateBps, msisdn } =
      req.body ?? {};

    const query = await backendRequest<{ status?: string }>(
      fetchImpl,
      config.paymentsApiUrl,
      `/api/v1/payments/transactions/${encodeURIComponent(String(checkoutRequestId ?? ""))}`,
    );

    if (query.status !== 200) {
      res.type("html").send(layout("Status check failed", errorCard(query.status, query.body)));
      return;
    }

    const status = query.body.status ?? "unknown";
    const recheckForm = `<form method="post" action="/app/payments/status">
      ${hidden("checkoutRequestId", checkoutRequestId)}
      ${hidden("tenantId", tenantId)}
      ${hidden("saleId", saleId)}
      ${hidden("attendantId", attendantId)}
      ${hidden("tillId", tillId)}
      ${hidden("totalMinorUnits", totalMinorUnits)}
      ${hidden("commissionRateBps", commissionRateBps)}
      ${hidden("msisdn", msisdn)}
      <button type="submit">Check again</button>
    </form>`;

    if (status !== "completed") {
      res.type("html").send(
        layout(
          "Payment status",
          `<p>Status: <strong>${esc(status)}</strong>${
            status === "pending" ? " - not a decline, just not resolved yet." : ""
          }</p>
          ${recheckForm}
          <p><a href="/app/dashboard">Back to dashboard</a></p>`,
        ),
      );
      return;
    }

    res.type("html").send(
      layout(
        "Payment status",
        `<p class="ok">Status: completed.</p>
        <form method="post" action="/app/commission/close">
          ${hidden("tenantId", tenantId)}
          ${hidden("saleId", saleId)}
          ${hidden("attendantId", attendantId)}
          ${hidden("totalMinorUnits", totalMinorUnits)}
          ${hidden("commissionRateBps", commissionRateBps)}
          ${hidden("attendantMsisdn", msisdn)}
          <label for="businessDate">Business date</label>
          <input id="businessDate" name="businessDate" type="date" value="${esc(todayIso())}" required>
          <button type="submit">Close commission for this sale</button>
        </form>
        <p><a href="/app/dashboard">Back to dashboard</a></p>`,
      ),
    );
  });

  router.post("/app/commission/close", requireSession, async (req, res) => {
    const { tenantId, saleId, attendantId, totalMinorUnits, commissionRateBps, attendantMsisdn, businessDate } =
      req.body ?? {};

    const close = await backendRequest<{
      payouts?: { status: string; conversationId?: string; error?: string }[];
      error?: string;
    }>(fetchImpl, config.commissionApiUrl, "/api/v1/commission/close", {
      method: "POST",
      // Sale-scoped, same as commission's own idempotency key for the B2C call it makes -
      // resubmitting this form for the same sale/date can't double-pay it.
      headers: { "Idempotency-Key": `web:close:${saleId}:${businessDate}` },
      body: {
        tenantId,
        businessDate,
        commissionRateBps: Number(commissionRateBps),
        sales: [
          {
            saleId,
            attendantId,
            attendantMsisdn,
            totalMinorUnits: Number(totalMinorUnits),
            paymentStatus: "paid",
          },
        ],
      },
    });

    if (close.status !== 201) {
      res.type("html").send(layout("Commission close failed", errorCard(close.status, close.body)));
      return;
    }

    const payout = close.body.payouts?.[0];
    res.type("html").send(
      layout(
        "Commission closed",
        `<div class="card">
          <p class="ok">Payout ${esc(payout?.status ?? "unknown")}.</p>
          ${payout?.conversationId ? `<p class="muted">conversationId: ${esc(payout.conversationId)}</p>` : ""}
          ${payout?.error ? `<p class="err">${esc(payout.error)}</p>` : ""}
        </div>
        <p><a href="/app/dashboard">Back to dashboard</a></p>`,
      ),
    );
  });

  return router;
}
