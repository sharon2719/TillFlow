import express from "express";
import { pinoHttp } from "pino-http";
import { DarajaMpesaAdapter, FakeMpesaAdapter, loadDarajaConfigFromEnv, type MpesaAdapter } from "@tillflow/shared";

import { createPool, type Queryable } from "./db.js";
import { logger } from "./logger.js";
import { createPaymentsRouter } from "./payments.js";
import { tracingMiddleware } from "./tracing.js";

/**
 * Real adapter when Daraja env vars are configured (see .env.daraja.example), the fake
 * otherwise. This is never how CI/k6 pick which one runs - they never set these env vars in
 * the first place, so they always get the fake, per the brief's explicit requirement,
 * independent of whether the real adapter exists.
 */
function defaultAdapter(): MpesaAdapter {
  try {
    return new DarajaMpesaAdapter(loadDarajaConfigFromEnv());
  } catch {
    return new FakeMpesaAdapter();
  }
}

/**
 * db and adapter are both injectable, same reasoning as services/pos/src/app.ts: tests
 * always pass a pg-mem-backed Queryable and never set the Daraja env vars, so they always
 * get the FakeMpesaAdapter regardless of what's configured elsewhere.
 */
export function createApp(db: Queryable = createPool(), adapter: MpesaAdapter = defaultAdapter()) {
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
