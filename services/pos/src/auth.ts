import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Queryable } from "./db.js";

export interface AuthContext {
  tenantId: string;
  attendantId: string;
  role: "owner" | "attendant";
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export function generateApiKey(): string {
  return `tfk_${randomBytes(24).toString("hex")}`;
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Resolves the Bearer token to exactly one tenant_id + role. This is the *only* source of
 * truth for which tenant a request acts on - see docs/adr/0007. Nothing downstream should
 * ever trust a client-supplied tenantId instead of req.auth.
 */
export function requireAuth(db: Queryable): RequestHandler {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing or malformed Authorization header" });
      return;
    }
    const rawKey = header.slice("Bearer ".length).trim();
    if (!rawKey) {
      res.status(401).json({ error: "missing or malformed Authorization header" });
      return;
    }

    const result = await db.query<{ tenant_id: string; attendant_id: string; role: string }>(
      `SELECT ak.tenant_id, ak.attendant_id, a.role
       FROM pos.api_keys ak
       JOIN pos.attendants a ON a.id = ak.attendant_id
       WHERE ak.key_hash = $1`,
      [hashApiKey(rawKey)],
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: "invalid API key" });
      return;
    }

    const row = result.rows[0];
    req.auth = {
      tenantId: row.tenant_id,
      attendantId: row.attendant_id,
      role: row.role as "owner" | "attendant",
    };
    next();
  };
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.role !== "owner") {
    res.status(403).json({ error: "owner role required" });
    return;
  }
  next();
}
