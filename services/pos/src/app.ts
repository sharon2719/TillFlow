import express from "express";
import { pinoHttp } from "pino-http";

import { createNoopCache, createRedisCache, type Cache } from "./cache.js";
import { createPool, type Queryable } from "./db.js";
import { healthRouter } from "./health.js";
import { logger } from "./logger.js";
import { createTenantsRouter } from "./routes/tenants.js";
import { createSalesRouter } from "./sales.js";
import { tracingMiddleware } from "./tracing.js";

/**
 * Same fallback shape as payments' defaultAdapter: no REDIS_URL (local/test) means auth
 * just always queries the DB, same as before this cache existed.
 */
function defaultCache(): Cache {
  const url = process.env.REDIS_URL;
  if (!url) return createNoopCache();
  try {
    return createRedisCache(url);
  } catch {
    return createNoopCache();
  }
}

/**
 * App construction is kept separate from `index.ts`'s `listen()` call so tests can import
 * `app` and drive it with supertest without binding a real port. `db` and `cache` are
 * injectable so tests can pass a pg-mem-backed Queryable and a no-op cache instead of
 * needing real Postgres/Redis to run against - production wiring (index.ts) just uses the
 * default real pool and Redis client.
 */
export function createApp(db: Queryable = createPool(), cache: Cache = defaultCache()) {
  const app = express();
  app.use(tracingMiddleware);
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(healthRouter);
  app.use(createTenantsRouter(db, cache));
  app.use(createSalesRouter(db, cache));

  app.get("/", (_req, res) => {
    res.json({ service: "pos", status: "ok" });
  });

  return app;
}

export const app = createApp();
