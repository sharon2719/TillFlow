import { randomUUID } from "node:crypto";
import { Router } from "express";

import { generateApiKey, hashApiKey, requireAuth, requireOwner } from "../auth.js";
import { createNoopCache, type Cache } from "../cache.js";
import type { Queryable } from "../db.js";

export function createTenantsRouter(db: Queryable, cache: Cache = createNoopCache()): Router {
  const router = Router();

  // Bootstrap: creates a tenant plus its first attendant (role "owner"), and returns the
  // raw API key exactly once. Nothing else ever sees this key again - only its hash is
  // stored. See docs/adr/0007.
  router.post("/tenants", async (req, res) => {
    const { name, ownerName, ownerMsisdn } = req.body ?? {};
    if (typeof name !== "string" || name.trim() === "") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (typeof ownerName !== "string" || ownerName.trim() === "") {
      res.status(400).json({ error: "ownerName is required" });
      return;
    }

    const tenantId = randomUUID();
    const ownerId = randomUUID();
    const keyId = randomUUID();
    const rawKey = generateApiKey();

    await db.query("INSERT INTO pos.tenants (id, name) VALUES ($1, $2)", [tenantId, name]);
    await db.query(
      "INSERT INTO pos.attendants (id, tenant_id, name, msisdn, role) VALUES ($1, $2, $3, $4, 'owner')",
      [ownerId, tenantId, ownerName, ownerMsisdn ?? null],
    );
    await db.query(
      "INSERT INTO pos.api_keys (id, tenant_id, attendant_id, key_hash) VALUES ($1, $2, $3, $4)",
      [keyId, tenantId, ownerId, hashApiKey(rawKey)],
    );

    res.status(201).json({ tenantId, ownerAttendantId: ownerId, apiKey: rawKey });
  });

  const authed = requireAuth(db, cache);

  // Adds an attendant to the CALLER's tenant - req.auth.tenantId, resolved from the API
  // key, never anything the client supplies in the body. This is the actual enforcement of
  // the validation boundary the ADR describes, not just its stated intent.
  router.post("/attendants", authed, requireOwner, async (req, res) => {
    const { name, msisdn, role } = req.body ?? {};
    if (typeof name !== "string" || name.trim() === "") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (role !== "owner" && role !== "attendant") {
      res.status(400).json({ error: "role must be 'owner' or 'attendant'" });
      return;
    }

    const attendantId = randomUUID();
    const keyId = randomUUID();
    const rawKey = generateApiKey();

    await db.query(
      "INSERT INTO pos.attendants (id, tenant_id, name, msisdn, role) VALUES ($1, $2, $3, $4, $5)",
      [attendantId, req.auth!.tenantId, name, msisdn ?? null, role],
    );
    // Same one-time-only raw key handout as tenant bootstrap - every attendant needs their
    // own credential to authenticate at all, not just the tenant's original owner.
    await db.query(
      "INSERT INTO pos.api_keys (id, tenant_id, attendant_id, key_hash) VALUES ($1, $2, $3, $4)",
      [keyId, req.auth!.tenantId, attendantId, hashApiKey(rawKey)],
    );

    res.status(201).json({ attendantId, tenantId: req.auth!.tenantId, role, apiKey: rawKey });
  });

  // Configures a till (and its commission rate) for the caller's tenant.
  router.post("/tills", authed, requireOwner, async (req, res) => {
    const { name, commissionRateBps } = req.body ?? {};
    if (typeof name !== "string" || name.trim() === "") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!Number.isInteger(commissionRateBps) || commissionRateBps < 0 || commissionRateBps > 10000) {
      res.status(400).json({ error: "commissionRateBps must be an integer between 0 and 10000" });
      return;
    }

    const tillId = randomUUID();
    await db.query(
      "INSERT INTO pos.tills (id, tenant_id, name, commission_rate_bps) VALUES ($1, $2, $3, $4)",
      [tillId, req.auth!.tenantId, name, commissionRateBps],
    );
    res.status(201).json({ tillId, tenantId: req.auth!.tenantId, name, commissionRateBps });
  });

  // Scoped to the caller's tenant only - proves the boundary holds on reads too, not just
  // on writes.
  router.get("/tills", authed, async (req, res) => {
    const result = await db.query<{ id: string; name: string; commission_rate_bps: number }>(
      "SELECT id, name, commission_rate_bps FROM pos.tills WHERE tenant_id = $1 ORDER BY created_at",
      [req.auth!.tenantId],
    );
    res.json({ tills: result.rows });
  });

  return router;
}
