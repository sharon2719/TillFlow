# @tillflow/shared

Shared code across services, per the brief's mono-repo layout. Now a real, buildable
workspace package (`npm run build --workspace=@tillflow/shared` -> `dist/`) consumed by
`services/payments`. `services/pos` still hasn't needed anything from here — its own
`logger.ts`/`health.ts` stay local until it does.

Any service that imports this package needs `services/_shared/dist` present in its own
Docker runtime stage too, at the same relative path (`services/_shared/...`) - that's where
the npm workspace symlink (`node_modules/@tillflow/shared -> ../../services/_shared`)
actually points, both locally and inside the image. See `services/payments/Dockerfile` for
the working example.

## Contents

- `src/mpesa-adapter.ts` — the `MpesaAdapter` interface and `FakeMpesaAdapter`, the
  deterministic implementation CI and k6 always run against (never the real one,
  regardless of what's configured elsewhere - the brief requires this).
- `src/daraja-adapter.ts` — `DarajaMpesaAdapter`, the real Safaricom Daraja sandbox client
  (OAuth token exchange, STK push/query, B2C). `services/payments/src/app.ts` uses it
  automatically once the env vars in `services/payments/.env.daraja.example` are set (copy
  to `.env.daraja.local`, gitignored, never commit real values), the fake otherwise. Live
  verification against the real sandbox — actually confirming a token exchange, an STK
  push, and a real callback all work — is tracked in `docs/production-readiness.md`, not
  assumed just because the code exists. `services/payments/scripts/test-daraja-sandbox.ts`
  is the standalone script for doing that verification.
- OTel tracing is *not* here, deliberately: each service has its own `src/tracing.ts`
  instead of one shared implementation. Auto-instrumentation
  (`@opentelemetry/auto-instrumentations-node`) needs a `--import` loader flag at process
  start to hook ESM's module resolution, which is fragile to get right across four
  Dockerfiles; manual span creation works the same in ESM as CJS with no loader flag, at
  the cost of ~60 near-identical lines duplicated four times. See any service's
  `tracing.ts` for the actual pattern (span-per-request middleware + W3C trace-context
  propagation on outgoing calls).

## Docker base pattern (documented here, applied per-service)

Every service's `Dockerfile` follows the same shape rather than sharing a literal base
image (each service has different runtime deps, so a shared `FROM` stage would just be
`node:22-alpine` again):

1. `deps` stage: pinned `node:22.x-alpine`, `npm ci` from the repo-root lockfile.
2. `build` stage: `npm run build --workspace=@tillflow/<name>`.
3. `runtime` stage: copy only `node_modules` + compiled `dist/`, create a non-root user,
   `USER` to it, expose the port, add a `HEALTHCHECK` against `/health`.

See `services/pos/Dockerfile` for the first working instance of this pattern.
