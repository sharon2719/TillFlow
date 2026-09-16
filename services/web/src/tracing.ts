import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { NextFunction, Request, Response } from "express";

const SERVICE_NAME = "web";

/**
 * Manual instrumentation, not the @opentelemetry/auto-instrumentations-node package: that
 * package's module-patching relies on require-in-the-middle, which doesn't reliably hook
 * into this repo's ESM ("type": "module") services without an extra --import loader flag on
 * every container's entrypoint. Explicit spans here are more code but work the same in ESM
 * as CJS, and let each service name its own spans after real business operations instead of
 * generic "GET /whatever".
 *
 * Exports to the ADOT sidecar on localhost:4317 (see infra/ecs-web.tf) - same container
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

/** Starts a new trace for each browser-originated request - web is the entry point of a
 * user-initiated chain (record sale -> request payment -> check status -> close
 * commission), so this is where those traces begin. */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  const span = tracer.startSpan(`${req.method} ${req.path}`, { kind: SpanKind.SERVER });
  const spanContext = trace.setSpan(context.active(), span);

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

/** Injects the active trace context into outgoing request headers - used on every call to
 * pos/payments/commission, so those calls join the same trace this request started. */
export function injectTraceHeaders(headers: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}
