import express from "express";
import { pinoHttp } from "pino-http";

import { commissionRouter } from "./commission.js";
import { logger } from "./logger.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(commissionRouter);
  app.get("/", (_req, res) => res.json({ service: "commission", status: "ok" }));
  return app;
}

export const app = createApp();
