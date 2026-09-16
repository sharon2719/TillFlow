import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { NextFunction, Request, Response } from "express";

const SERVICE_NAME = "commission";

/**
 * Manual instrumentation, not the @opentelemetry/auto-instrumentations-node package: that
 * package's module-patching relies on require-in-the-middle, which doesn't reliably hook
 * into this repo's ESM ("type": "module") services without an extra --import loader flag on
 * every container's entrypoint. Explicit spans here are more code but work the same in ESM
 * as CJS, and let each service name its own spans after real business operations instead of
 * generic "GET /whatever".
 *
 * Exports to the ADOT sidecar on localhost:4317 (see infra/ecs-*.tf) - same container
 * network namespace, no extra config needed.
 */
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME }),
  // Skips the real exporter under vitest (which sets process.env.VITEST) - a provider with
  // no span processor still creates spans (so the middleware/propagation logic below is
  // exercised in tests), it just never tries to reach the ADOT sidecar over the network,
  // which doesn't exist in a test run and would otherwise spam connection-refused retries.
  spanProcessors: process.env.VITEST
    ? []
    : [new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://localhost:4317" }))],
});
provider.register();

export const tracer = trace.getTracer(SERVICE_NAME);

/** Continues an incoming trace (e.g. from web) if a traceparent header is present, starts a
 * new one otherwise - this is what makes "sale -> payment -> callback/reconciliation" show
 * up as one connected trace instead of isolated per-service spans. */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  const parentContext = propagation.extract(context.active(), req.headers);
  const span = tracer.startSpan(`${req.method} ${req.path}`, { kind: SpanKind.SERVER }, parentContext);
  const spanContext = trace.setSpan(parentContext, span);

  context.with(spanContext, () => {
    res.on("finish", () => {
      span.setAttribute("http.status_code", res.statusCode);
      if (res.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    });
    next();
  });
}

/** Injects the active trace context into outgoing request headers - used on the call to
 * payments' B2C endpoint, so that call joins this same trace instead of starting a new
 * one. */
export function injectTraceHeaders(headers: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}
