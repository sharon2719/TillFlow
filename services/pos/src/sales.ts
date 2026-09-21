import { randomUUID } from "node:crypto";
import { Router } from "express";

import { requireAuth } from "./auth.js";
import { createNoopCache, type Cache } from "./cache.js";
import type { Queryable } from "./db.js";

export interface SaleItemInput {
  sku: string;
  quantity: number;
  unitPriceMinorUnits: number;
}

/**
 * Sale recording, reworked to actually use the tenant/auth model instead of trusting
 * client-supplied tenantId/attendantId (the original version accepted both directly from
 * the request body - exactly the threat docs/threat-model.md #3 and docs/adr/0007 exist to
 * prevent). tenantId and attendantId now come from the authenticated API key only.
 */
export function createSalesRouter(db: Queryable, cache: Cache = createNoopCache()): Router {
  const router = Router();
  const authed = requireAuth(db, cache);

  router.post("/api/v1/sales", authed, async (req, res) => {
    const idempotencyKey = req.header("Idempotency-Key");
    if (!idempotencyKey?.trim()) {
      // No silent random-key fallback - the point of idempotency is that a client-chosen
      // key lets a retry be recognized as a retry. Without one, there's nothing to dedupe.
      res.status(400).json({ error: "Idempotency-Key header is required" });
      return;
    }

    const { tillId, items } = req.body ?? {};
    if (typeof tillId !== "string" || !tillId.trim()) {
      res.status(400).json({ error: "tillId is required" });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "items must be a non-empty array" });
      return;
    }

    let parsedItems: SaleItemInput[];
    try {
      parsedItems = items.map((item, index) => {
        if (!item || typeof item !== "object") throw new Error(`items[${index}] must be an object`);
        const record = item as Record<string, unknown>;
        if (typeof record.sku !== "string" || !record.sku.trim()) {
          throw new Error(`items[${index}].sku is required`);
        }
        if (typeof record.quantity !== "number" || !Number.isInteger(record.quantity) || record.quantity <= 0) {
          throw new Error(`items[${index}].quantity must be a positive integer`);
        }
        if (
          typeof record.unitPriceMinorUnits !== "number" ||
          !Number.isInteger(record.unitPriceMinorUnits) ||
          record.unitPriceMinorUnits < 0
        ) {
          throw new Error(`items[${index}].unitPriceMinorUnits must be a non-negative integer`);
        }
        return {
          sku: record.sku,
          quantity: record.quantity,
          unitPriceMinorUnits: record.unitPriceMinorUnits,
        } satisfies SaleItemInput;
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "invalid items" });
      return;
    }

    const { tenantId, attendantId } = req.auth!;

    // The till must actually belong to this tenant - never just "exist somewhere."
    const tillCheck = await db.query<{ id: string }>(
      "SELECT id FROM pos.tills WHERE id = $1 AND tenant_id = $2",
      [tillId, tenantId],
    );
    if (tillCheck.rows.length === 0) {
      res.status(400).json({ error: "tillId does not belong to this tenant" });
      return;
    }

    // Check-first for the common case (clean 409, no dependence on DB-specific error
    // shapes); the UNIQUE (tenant_id, idempotency_key) constraint in the migration is the
    // real safety net if two identical requests race each other.
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM pos.sales WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, idempotencyKey],
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: "Duplicate idempotency key" });
      return;
    }

    const totalMinorUnits = parsedItems.reduce(
      (total, item) => total + item.quantity * item.unitPriceMinorUnits,
      0,
    );
    const saleId = randomUUID();

    try {
      await db.query(
        `INSERT INTO pos.sales (id, tenant_id, attendant_id, till_id, total_minor_units, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [saleId, tenantId, attendantId, tillId, totalMinorUnits, idempotencyKey],
      );
    } catch (err: any) {
      // Defense-in-depth for the race the check-first query can't fully close.
      if (err?.code === "23505") {
        res.status(409).json({ error: "Duplicate idempotency key" });
        return;
      }
      throw err;
    }

    for (const item of parsedItems) {
      await db.query(
        `INSERT INTO pos.sale_items (id, sale_id, sku, quantity, unit_price_minor_units)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), saleId, item.sku, item.quantity, item.unitPriceMinorUnits],
      );
    }

    res.status(201).json({
      saleId,
      tenantId,
      attendantId,
      tillId,
      totalMinorUnits,
      status: "recorded",
      items: parsedItems,
    });
  });

  // Scoped to the caller's tenant, same pattern as GET /tills.
  router.get("/api/v1/sales/:saleId", authed, async (req, res) => {
    const result = await db.query<{
      id: string;
      attendant_id: string;
      till_id: string;
      total_minor_units: number;
      created_at: string;
    }>("SELECT id, attendant_id, till_id, total_minor_units, created_at FROM pos.sales WHERE id = $1 AND tenant_id = $2", [
      req.params.saleId,
      req.auth!.tenantId,
    ]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: "sale not found" });
      return;
    }

    const sale = result.rows[0];
    res.json({
      saleId: sale.id,
      tenantId: req.auth!.tenantId,
      attendantId: sale.attendant_id,
      tillId: sale.till_id,
      totalMinorUnits: sale.total_minor_units,
      createdAt: sale.created_at,
    });
  });

  return router;
}
