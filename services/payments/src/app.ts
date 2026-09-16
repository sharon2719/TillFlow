import express from "express";
import { pinoHttp } from "pino-http";

import { logger } from "./logger.js";
import { paymentsRouter } from "./payments.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(paymentsRouter);

  app.get("/", (_req, res) => {
    res.json({ service: "payments", status: "ok" });
  });

  return app;
}

export const app = createApp();
