import { randomUUID } from "node:crypto";
import { Router } from "express";

import type { Queryable } from "./db.js";

interface PaidSale {
  saleId: string;
  attendantId: string;
  attendantMsisdn: string;
  totalMinorUnits: number;
  paymentStatus: "paid" | "pending" | "failed";
}

interface CloseRequest {
  tenantId: string;
  businessDate: string;
  commissionRateBps: number;
  sales: PaidSale[];
}

export type B2cCallResult = { ok: true; conversationId: string } | { ok: false; error: string };

/**
 * Calls Payments over HTTP - never Daraja directly, per the brief's explicit rule. This is
 * the ONLY thing that changed conceptually from the original version: it used to just mark
 * a payout "requested" locally and stop, which meant no B2C ever actually happened.
 */
export type B2cCaller = (req: {
  tenantId: string;
  payoutId: string;
  msisdn: string;
  amountMinorUnits: number;
  idempotencyKey: string;
}) => Promise<B2cCallResult>;

export function defaultB2cCaller(paymentsApiUrl: string): B2cCaller {
  return async (req) => {
    try {
      const res = await fetch(`${paymentsApiUrl}/api/v1/payments/b2c`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const body = (await res.json().catch(() => ({}))) as { conversationId?: string; error?: string };
      if (res.status === 201 && body.conversationId) {
        return { ok: true, conversationId: body.conversationId };
      }
      if (res.status === 409 && body.conversationId) {
        // Payments itself already has this exact idempotency key - not a new failure, the
        // payout is already in flight there. Treat it the same as a successful call.
        return { ok: true, conversationId: body.conversationId };
      }
      return { ok: false, error: body.error ?? `payments returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "payments call failed" };
    }
  };
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const isMsisdn = (value: string) => /^254\d{9}$/.test(value);

function validate(body: unknown): CloseRequest {
  if (!body || typeof body !== "object") throw new Error("request body is required");
  const payload = body as Record<string, unknown>;
  if (typeof payload.tenantId !== "string" || !payload.tenantId.trim()) throw new Error("tenantId is required");
  if (typeof payload.businessDate !== "string" || !isDate(payload.businessDate)) throw new Error("businessDate must be YYYY-MM-DD");
  if (
    typeof payload.commissionRateBps !== "number" ||
    !Number.isInteger(payload.commissionRateBps) ||
    payload.commissionRateBps < 0 ||
    payload.commissionRateBps > 10000
  ) {
    throw new Error("commissionRateBps must be an integer between 0 and 10000");
  }
  if (!Array.isArray(payload.sales)) throw new Error("sales must be an array");

  const sales = payload.sales.map((sale, index) => {
    if (!sale || typeof sale !== "object") throw new Error(`sales[${index}] must be an object`);
    const item = sale as Record<string, unknown>;
    if (typeof item.saleId !== "string" || !item.saleId.trim()) throw new Error(`sales[${index}].saleId is required`);
    if (typeof item.attendantId !== "string" || !item.attendantId.trim()) throw new Error(`sales[${index}].attendantId is required`);
    if (typeof item.attendantMsisdn !== "string" || !isMsisdn(item.attendantMsisdn)) throw new Error(`sales[${index}].attendantMsisdn is invalid`);
    if (typeof item.totalMinorUnits !== "number" || !Number.isInteger(item.totalMinorUnits) || item.totalMinorUnits <= 0) throw new Error(`sales[${index}].totalMinorUnits is invalid`);
    if (item.paymentStatus !== "paid" && item.paymentStatus !== "pending" && item.paymentStatus !== "failed") throw new Error(`sales[${index}].paymentStatus is invalid`);
    return {
      saleId: item.saleId,
      attendantId: item.attendantId,
      attendantMsisdn: item.attendantMsisdn,
      totalMinorUnits: item.totalMinorUnits,
      paymentStatus: item.paymentStatus,
    } satisfies PaidSale;
  });

  return { tenantId: payload.tenantId, businessDate: payload.businessDate, commissionRateBps: payload.commissionRateBps, sales };
}

export function createCommissionRouter(db: Queryable, callB2c: B2cCaller): Router {
  const router = Router();

  router.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  // Also mounted under the path the ALB's listener rule actually routes here
  // (/api/v1/commission/*, see infra/alb.tf) - bare /health falls through to pos's default
  // action instead, since it doesn't match that path pattern.
  router.get("/api/v1/commission/health", (_req, res) => res.status(200).json({ status: "ok" }));

  router.post("/api/v1/commission/close", async (req, res) => {
    try {
      const close = validate(req.body);
      const idempotencyKey = req.get("Idempotency-Key");
      if (!idempotencyKey?.trim()) {
        res.status(400).json({ error: "Idempotency-Key is required" });
        return;
      }

      const existingClose = await db.query<{ id: string }>(
        "SELECT id FROM commission.closes WHERE tenant_id = $1 AND business_date = $2 AND idempotency_key = $3",
        [close.tenantId, close.businessDate, idempotencyKey],
      );
      if (existingClose.rows.length > 0) {
        res.status(409).json({ error: "Commission close already processed" });
        return;
      }

      const closeId = randomUUID();
      await db.query(
        "INSERT INTO commission.closes (id, tenant_id, business_date, idempotency_key) VALUES ($1, $2, $3, $4)",
        [closeId, close.tenantId, close.businessDate, idempotencyKey],
      );

      const eligible = close.sales.filter((sale) => sale.paymentStatus === "paid");
      const payouts = [];

      for (const sale of eligible) {
        // The database's own UNIQUE (tenant_id, business_date, sale_id) index is the real
        // backstop against double-pay - this check-first query just avoids an unnecessary
        // B2C call for the common case of an already-paid sale, it isn't the only thing
        // standing between a retry and a duplicate payout.
        const already = await db.query<{ id: string; b2c_conversation_id: string | null; status: string }>(
          "SELECT id, b2c_conversation_id, status FROM commission.payouts WHERE tenant_id = $1 AND business_date = $2 AND sale_id = $3",
          [close.tenantId, close.businessDate, sale.saleId],
        );
        if (already.rows.length > 0) {
          payouts.push({
            payoutId: already.rows[0].id,
            saleId: sale.saleId,
            attendantId: sale.attendantId,
            status: already.rows[0].status,
            conversationId: already.rows[0].b2c_conversation_id,
            note: "already paid out for this sale - not re-requested",
          });
          continue;
        }

        const amountMinorUnits = Math.floor((sale.totalMinorUnits * close.commissionRateBps) / 10000);
        const payoutId = randomUUID();
        // Tied to the sale, not the close's own idempotency key - so even a close retried
        // under a different key still can't double-pay the same sale's commission.
        const b2cIdempotencyKey = `commission:${close.tenantId}:${sale.saleId}`;

        const result = await callB2c({
          tenantId: close.tenantId,
          payoutId,
          msisdn: sale.attendantMsisdn,
          amountMinorUnits,
          idempotencyKey: b2cIdempotencyKey,
        });

        try {
          await db.query(
            `INSERT INTO commission.payouts
               (id, close_id, tenant_id, business_date, sale_id, attendant_id, attendant_msisdn, amount_minor_units, status, b2c_idempotency_key, b2c_conversation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              payoutId,
              closeId,
              close.tenantId,
              close.businessDate,
              sale.saleId,
              sale.attendantId,
              sale.attendantMsisdn,
              amountMinorUnits,
              result.ok ? "requested" : "b2c_call_failed",
              b2cIdempotencyKey,
              result.ok ? result.conversationId : null,
            ],
          );
        } catch (err: any) {
          if (err?.code === "23505") {
            // Lost the race to another concurrent close for the same sale - the other one
            // wins, this one doesn't also request a payout.
            continue;
          }
          throw err;
        }

        payouts.push({
          payoutId,
          saleId: sale.saleId,
          attendantId: sale.attendantId,
          amountMinorUnits,
          status: result.ok ? "requested" : "b2c_call_failed",
          conversationId: result.ok ? result.conversationId : undefined,
          error: result.ok ? undefined : result.error,
        });
      }

      res.status(201).json({
        closeId,
        tenantId: close.tenantId,
        businessDate: close.businessDate,
        eligibleSales: eligible.length,
        payouts,
      });
    } catch (err: any) {
      if (err?.code === "23505") {
        res.status(409).json({ error: "Commission close already processed" });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid commission close" });
    }
  });

  return router;
}
