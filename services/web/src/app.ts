import express from "express";
import { pinoHttp } from "pino-http";

import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createWebRouter } from "./routes.js";
import { tracingMiddleware } from "./tracing.js";

export function createApp(config = loadConfig(), fetchImpl: typeof fetch = fetch) {
  const app = express();
  app.use(tracingMiddleware);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(pinoHttp({ logger }));
  app.use(createWebRouter(config, fetchImpl));
  return app;
}

export const app = createApp();
