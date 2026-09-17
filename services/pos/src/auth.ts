import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { createNoopCache, type Cache } from "./cache.js";
import type { Queryable } from "./db.js";

// Short on purpose: bounds how long a revoked/rotated API key can still authenticate
// through a stale cache entry, rather than caching for as long as possible.
const AUTH_CACHE_TTL_SECONDS = 30;

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
export function requireAuth(db: Queryable, cache: Cache = createNoopCache()): RequestHandler {
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

    const keyHash = hashApiKey(rawKey);
    const cacheKey = `pos:apikey:${keyHash}`;

    // The Cache contract (cache.ts) says its own methods never throw, but auth is the one
    // path every request depends on - guarding here too means even a misbehaving Cache
    // implementation can only ever degrade this to a DB lookup, never break auth outright.
    let cached: string | null = null;
    try {
      cached = await cache.get(cacheKey);
    } catch {
      cached = null;
    }
    if (cached) {
      try {
        req.auth = JSON.parse(cached) as AuthContext;
        next();
        return;
      } catch {
        // Corrupt/unexpected cache value - fall through to the real DB lookup below rather
        // than reject a request over a cache-layer problem.
      }
    }

    const result = await db.query<{ tenant_id: string; attendant_id: string; role: string }>(
      `SELECT ak.tenant_id, ak.attendant_id, a.role
       FROM pos.api_keys ak
       JOIN pos.attendants a ON a.id = ak.attendant_id
       WHERE ak.key_hash = $1`,
      [keyHash],
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
    try {
      await cache.set(cacheKey, JSON.stringify(req.auth), AUTH_CACHE_TTL_SECONDS);
    } catch {
      // Same reasoning as the get() guard above - a failed write just means next request
      // misses the cache too, not that this one fails.
    }
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
