import { Router } from "express";

import type { Queryable } from "./db.js";

/**
 * /health never touches the DB (liveness: is the process up at all), /ready does
 * (readiness: can this instance actually serve a real request). Distinguishing them matters:
 * a slow query shouldn't make ECS think the process itself is dead, but a fully broken DB
 * connection - e.g. a rotated credential this container hasn't picked up yet, see
 * docs/recovery-drills.md's "Incident 1" - should make this instance report unready rather
 * than silently claim healthy forever.
 */
export function createHealthRouter(db: Queryable): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/ready", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.status(200).json({ status: "ready" });
    } catch (err) {
      res.status(503).json({ status: "not ready", error: err instanceof Error ? err.message : "DB check failed" });
    }
  });

  return router;
}
