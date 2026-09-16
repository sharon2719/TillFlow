import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "commission" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
