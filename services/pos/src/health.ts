import { Router } from "express";

export const healthRouter = Router();

// Liveness: the process is up and able to handle a request at all.
healthRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Readiness: dependencies (RDS, Redis) are reachable.
// TODO(G2): wire real checks once this service has a DB/cache client to check.
healthRouter.get("/ready", (_req, res) => {
  res.status(200).json({ status: "ready" });
});
