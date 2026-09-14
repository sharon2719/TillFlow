import express from "express";
import { pinoHttp } from "pino-http";

import { healthRouter } from "./health.js";
import { logger } from "./logger.js";

/**
 * App construction is kept separate from `index.ts`'s `listen()` call so tests can import
 * `app` and drive it with supertest without binding a real port.
 */
export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(pinoHttp({ logger }));
  app.use(healthRouter);

  app.get("/", (_req, res) => {
    res.json({ service: "pos", status: "ok" });
  });

  return app;
}

export const app = createApp();
