import express from "express";
import { pinoHttp } from "pino-http";

import { createCommissionRouter, defaultB2cCaller, type B2cCaller } from "./commission.js";
import { createPool, type Queryable } from "./db.js";
import { logger } from "./logger.js";
import { tracingMiddleware } from "./tracing.js";

/**
 * db and callB2c are both injectable (same reasoning as pos/payments): tests use a
 * pg-mem-backed Queryable and point callB2c at a real in-process Payments instance instead
 * of hitting anything over the network. Production default reads PAYMENTS_API_URL, which
 * points at the shared ALB (see infra/ecs-commission.tf).
 */
export function createApp(
  db: Queryable = createPool(),
  callB2c: B2cCaller = defaultB2cCaller(process.env.PAYMENTS_API_URL ?? "http://localhost:3001"),
) {
  const app = express();
  app.use(tracingMiddleware);
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(createCommissionRouter(db, callB2c));
  app.get("/", (_req, res) => res.json({ service: "commission", status: "ok" }));
  return app;
}

export const app = createApp();
