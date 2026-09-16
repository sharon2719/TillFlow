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
  deterministic implementation CI and k6 run against. The real `DarajaMpesaAdapter` isn't
  written yet - `services/payments` still runs entirely against the fake, which is correct
  for now (the brief requires the fake for CI/k6 regardless), but real Daraja sandbox
  integration is still open work.
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
