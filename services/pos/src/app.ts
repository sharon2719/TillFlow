import express from "express";
import { pinoHttp } from "pino-http";

import { createPool, type Queryable } from "./db.js";
import { healthRouter } from "./health.js";
import { logger } from "./logger.js";
import { createTenantsRouter } from "./routes/tenants.js";
import { createSalesRouter } from "./sales.js";
import { tracingMiddleware } from "./tracing.js";

/**
 * App construction is kept separate from `index.ts`'s `listen()` call so tests can import
 * `app` and drive it with supertest without binding a real port. `db` is injectable so
 * tests can pass a pg-mem-backed Queryable instead of needing a real Postgres to run
 * against - production wiring (index.ts) just uses the default real pool.
 */
export function createApp(db: Queryable = createPool()) {
  const app = express();
  app.use(tracingMiddleware);
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(healthRouter);
  app.use(createTenantsRouter(db));
  app.use(createSalesRouter(db));

  app.get("/", (_req, res) => {
    res.json({ service: "pos", status: "ok" });
  });

  return app;
}

export const app = createApp();
