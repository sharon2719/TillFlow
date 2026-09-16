import express from "express";
import { pinoHttp } from "pino-http";

import { logger } from "./logger.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", (_req, res) => res.json({ status: "ready" }));
  app.get("/", (_req, res) => res.json({ service: "web", status: "ok" }));
  return app;
}

export const app = createApp();
