import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { MpesaAdapter } from "@tillflow/shared";

import type { Queryable } from "./db.js";

interface StkPushBody {
  tenantId: string;
  saleId: string;
  msisdn: string;
  amountMinorUnits: number;
  accountReference: string;
  idempotencyKey: string;
  simulate?: "timeout" | "reject";
}

interface B2cBody {
  tenantId: string;
  payoutId: string;
  msisdn: string;
  amountMinorUnits: number;
  idempotencyKey: string;
  simulate?: "timeout" | "reject";
}

const isValidMsisdn = (value: unknown): value is string => typeof value === "string" && /^254\d{9}$/.test(value);

function validateStk(body: unknown): StkPushBody {
  if (!body || typeof body !== "object") throw new Error("request body is required");
  const p = body as Record<string, unknown>;
  if (typeof p.tenantId !== "string" || !p.tenantId.trim()) throw new Error("tenantId is required");
  if (typeof p.saleId !== "string" || !p.saleId.trim()) throw new Error("saleId is required");
  if (!isValidMsisdn(p.msisdn)) throw new Error("msisdn must be a valid 254 format number");
  if (typeof p.accountReference !== "string" || !p.accountReference.trim()) throw new Error("accountReference is required");
  if (typeof p.idempotencyKey !== "string" || !p.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
  if (typeof p.amountMinorUnits !== "number" || !Number.isInteger(p.amountMinorUnits) || p.amountMinorUnits <= 0) {
    throw new Error("amountMinorUnits must be a positive integer");
  }
  if (p.simulate !== undefined && p.simulate !== "timeout" && p.simulate !== "reject") {
    throw new Error("simulate must be 'timeout' or 'reject' if present");
  }
  return {
    tenantId: p.tenantId,
    saleId: p.saleId,
    msisdn: p.msisdn,
    amountMinorUnits: p.amountMinorUnits,
    accountReference: p.accountReference,
    idempotencyKey: p.idempotencyKey,
    simulate: p.simulate as StkPushBody["simulate"],
  };
}

function validateB2c(body: unknown): B2cBody {
  if (!body || typeof body !== "object") throw new Error("request body is required");
  const p = body as Record<string, unknown>;
  if (typeof p.tenantId !== "string" || !p.tenantId.trim()) throw new Error("tenantId is required");
  if (typeof p.payoutId !== "string" || !p.payoutId.trim()) throw new Error("payoutId is required");
  if (!isValidMsisdn(p.msisdn)) throw new Error("msisdn must be a valid 254 format number");
  if (typeof p.idempotencyKey !== "string" || !p.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
  if (typeof p.amountMinorUnits !== "number" || !Number.isInteger(p.amountMinorUnits) || p.amountMinorUnits <= 0) {
    throw new Error("amountMinorUnits must be a positive integer");
  }
  if (p.simulate !== undefined && p.simulate !== "timeout" && p.simulate !== "reject") {
    throw new Error("simulate must be 'timeout' or 'reject' if present");
  }
  return {
    tenantId: p.tenantId,
    payoutId: p.payoutId,
    msisdn: p.msisdn,
    amountMinorUnits: p.amountMinorUnits,
    idempotencyKey: p.idempotencyKey,
    simulate: p.simulate as B2cBody["simulate"],
  };
}

/**
 * Payments has no caller authentication yet (unlike pos's Bearer-key model) - it's only
 * reachable from inside the VPC today, not the public internet, but that's network
 * isolation, not authentication. Real fix (service-to-service auth between Commission and
 * Payments) is a tracked gap in docs/production-readiness.md, not silently skipped.
 */
export function createPaymentsRouter(db: Queryable, adapter: MpesaAdapter): Router {
  const router = Router();

  router.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  router.post("/api/v1/payments/stk", async (req, res) => {
    try {
      const body = validateStk(req.body);

      const existing = await db.query<{ checkout_request_id: string; status: string }>(
        "SELECT checkout_request_id, status FROM payments.stk_requests WHERE tenant_id = $1 AND idempotency_key = $2",
        [body.tenantId, body.idempotencyKey],
      );
      if (existing.rows.length > 0) {
        res.status(409).json({ error: "Duplicate idempotency key", checkoutRequestId: existing.rows[0].checkout_request_id, status: existing.rows[0].status });
        return;
      }

      const result = await adapter.stkPush({
        tenantId: body.tenantId,
        saleId: body.saleId,
        msisdn: body.msisdn,
        amountMinorUnits: body.amountMinorUnits,
        accountReference: body.accountReference,
        idempotencyKey: body.idempotencyKey,
        simulate: body.simulate,
      });

      if (result.status === "rejected") {
        res.status(422).json({ error: "rejected", reason: result.reason });
        return;
      }

      // A "timeout" simulation still gets a checkoutRequestId (Daraja did accept the push -
      // it's the *result* that's delayed) - status starts "pending" either way, and only
      // reconciliation (GET /transactions/:id) or the callback below moves it further. This
      // is the actual mechanism behind "a timeout is not a decline".
      const id = randomUUID();
      await db.query(
        `INSERT INTO payments.stk_requests
           (id, tenant_id, sale_id, msisdn, amount_minor_units, account_reference, checkout_request_id, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
        [id, body.tenantId, body.saleId, body.msisdn, body.amountMinorUnits, body.accountReference, result.checkoutRequestId, body.idempotencyKey],
      );

      res.status(201).json({
        paymentId: id,
        tenantId: body.tenantId,
        saleId: body.saleId,
        checkoutRequestId: result.checkoutRequestId,
        status: "pending",
      });
    } catch (err: any) {
      if (err?.code === "23505") {
        res.status(409).json({ error: "Duplicate idempotency key" });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid STK request" });
    }
  });

  // Daraja's STK result callback. Trusted at face value for now - no signature/source
  // verification yet (docs/threat-model.md #1 is only partially mitigated: replay/reorder
  // is handled by the state-machine check below, forged origin is not). Real fix needs a
  // way to verify the caller actually is Daraja, tracked in docs/production-readiness.md.
  router.post("/api/v1/payments/callback", async (req, res) => {
    const { checkoutRequestId, resultCode, resultDescription } = req.body as {
      checkoutRequestId?: string;
      resultCode?: string;
      resultDescription?: string;
    };
    if (!checkoutRequestId || typeof checkoutRequestId !== "string") {
      res.status(400).json({ error: "checkoutRequestId is required" });
      return;
    }

    const existing = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM payments.stk_requests WHERE checkout_request_id = $1",
      [checkoutRequestId],
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "payment not found" });
      return;
    }

    // One legal transition: pending -> (completed | failed). A callback arriving twice (or
    // a reordered replay) is a no-op the second time, not a second state change - this is
    // what "one legal transition, one ledger effect" actually means in code, not just in
    // the doc describing it.
    if (existing.rows[0].status !== "pending") {
      res.status(200).json({ paymentId: existing.rows[0].id, status: existing.rows[0].status, note: "already resolved, callback ignored" });
      return;
    }

    const nextStatus = resultCode === "0" ? "completed" : "failed";
    await db.query(
      "UPDATE payments.stk_requests SET status = $1, result_code = $2, result_description = $3, updated_at = now() WHERE checkout_request_id = $4",
      [nextStatus, resultCode ?? null, resultDescription ?? null, checkoutRequestId],
    );

    res.status(200).json({ paymentId: existing.rows[0].id, checkoutRequestId, status: nextStatus, resultCode, resultDescription });
  });

  router.post("/api/v1/payments/b2c", async (req, res) => {
    try {
      const body = validateB2c(req.body);

      const existing = await db.query<{ conversation_id: string; status: string }>(
        "SELECT conversation_id, status FROM payments.b2c_requests WHERE tenant_id = $1 AND idempotency_key = $2",
        [body.tenantId, body.idempotencyKey],
      );
      if (existing.rows.length > 0) {
        res.status(409).json({ error: "Duplicate idempotency key", conversationId: existing.rows[0].conversation_id, status: existing.rows[0].status });
        return;
      }

      const result = await adapter.b2c({
        tenantId: body.tenantId,
        payoutId: body.payoutId,
        msisdn: body.msisdn,
        amountMinorUnits: body.amountMinorUnits,
        idempotencyKey: body.idempotencyKey,
        simulate: body.simulate,
      });

      if (result.status === "rejected") {
        res.status(422).json({ error: "rejected", reason: result.reason });
        return;
      }

      const id = randomUUID();
      await db.query(
        `INSERT INTO payments.b2c_requests
           (id, tenant_id, payout_id, msisdn, amount_minor_units, conversation_id, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
        [id, body.tenantId, body.payoutId, body.msisdn, body.amountMinorUnits, result.conversationId, body.idempotencyKey],
      );

      res.status(201).json({
        payoutRequestId: id,
        tenantId: body.tenantId,
        payoutId: body.payoutId,
        conversationId: result.conversationId,
        status: "pending",
      });
    } catch (err: any) {
      if (err?.code === "23505") {
        res.status(409).json({ error: "Duplicate idempotency key" });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid B2C request" });
    }
  });

  // Daraja's B2C result callback - same one-legal-transition guard as the STK callback.
  router.post("/api/v1/payments/b2c/callback", async (req, res) => {
    const { conversationId, resultCode, resultDescription } = req.body as {
      conversationId?: string;
      resultCode?: string;
      resultDescription?: string;
    };
    if (!conversationId || typeof conversationId !== "string") {
      res.status(400).json({ error: "conversationId is required" });
      return;
    }

    const existing = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM payments.b2c_requests WHERE conversation_id = $1",
      [conversationId],
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "payout not found" });
      return;
    }
    if (existing.rows[0].status !== "pending") {
      res.status(200).json({ payoutRequestId: existing.rows[0].id, status: existing.rows[0].status, note: "already resolved, callback ignored" });
      return;
    }

    const nextStatus = resultCode === "0" ? "completed" : "failed";
    await db.query(
      "UPDATE payments.b2c_requests SET status = $1, result_code = $2, result_description = $3, updated_at = now() WHERE conversation_id = $4",
      [nextStatus, resultCode ?? null, resultDescription ?? null, conversationId],
    );

    res.status(200).json({ payoutRequestId: existing.rows[0].id, conversationId, status: nextStatus, resultCode, resultDescription });
  });

  // Transaction query / reconciliation: if we already know the answer, return it without
  // touching the adapter. If still pending, ask Daraja directly - this is the mechanism a
  // stuck "pending" transaction (lost callback, or a deliberately simulated timeout)
  // actually gets resolved through, not just a doc describing that it should be possible.
  router.get("/api/v1/payments/transactions/:id", async (req, res) => {
    const id = req.params.id;

    const stk = await db.query<{ id: string; status: string; result_code: string | null; result_description: string | null }>(
      "SELECT id, status, result_code, result_description FROM payments.stk_requests WHERE checkout_request_id = $1",
      [id],
    );
    const b2c = stk.rows.length === 0
      ? await db.query<{ id: string; status: string; result_code: string | null; result_description: string | null }>(
          "SELECT id, status, result_code, result_description FROM payments.b2c_requests WHERE conversation_id = $1",
          [id],
        )
      : { rows: [] as any[] };

    const record = stk.rows[0] ?? b2c.rows[0];
    if (!record) {
      res.status(404).json({ error: "transaction not found" });
      return;
    }

    if (record.status !== "pending") {
      res.json({ id, status: record.status, resultCode: record.result_code, resultDescription: record.result_description, source: "local" });
      return;
    }

    const queried = await adapter.queryTransaction(id);
    if (queried.status !== "pending") {
      const table = stk.rows.length > 0 ? "payments.stk_requests" : "payments.b2c_requests";
      const idColumn = stk.rows.length > 0 ? "checkout_request_id" : "conversation_id";
      await db.query(
        `UPDATE ${table} SET status = $1, result_code = $2, result_description = $3, updated_at = now() WHERE ${idColumn} = $4`,
        [queried.status, queried.resultCode ?? null, queried.resultDescription ?? null, id],
      );
    }

    res.json({ id, status: queried.status, resultCode: queried.resultCode, resultDescription: queried.resultDescription, source: "reconciled" });
  });

  return router;
}
