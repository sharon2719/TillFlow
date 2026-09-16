import express from "express";
import { pinoHttp } from "pino-http";
import { FakeMpesaAdapter, type MpesaAdapter } from "@tillflow/shared";

import { createPool, type Queryable } from "./db.js";
import { logger } from "./logger.js";
import { createPaymentsRouter } from "./payments.js";
import { tracingMiddleware } from "./tracing.js";

/**
 * db and adapter are both injectable, same reasoning as services/pos/src/app.ts: tests use
 * a pg-mem-backed Queryable and the FakeMpesaAdapter is already the deterministic one CI/k6
 * are supposed to run against, so it's also the production default - the real
 * DarajaMpesaAdapter isn't written yet, see services/_shared/README.md.
 */
export function createApp(db: Queryable = createPool(), adapter: MpesaAdapter = new FakeMpesaAdapter()) {
  const app = express();
  app.use(tracingMiddleware);
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(createPaymentsRouter(db, adapter));

  app.get("/", (_req, res) => {
    res.json({ service: "payments", status: "ok" });
  });

  return app;
}

export const app = createApp();
