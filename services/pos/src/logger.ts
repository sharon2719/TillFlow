import pino from "pino";

// TODO(G1): once the ADOT sidecar is wired in, inject trace_id/span_id from the active
// OTel context here so every log line correlates with its trace, per the brief's
// "JSON logs carry trace_id/span_id" requirement.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "pos" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
