# @tillflow/shared

Shared code across services, per the brief's mono-repo layout. Nothing here is consumed by
another workspace yet — `services/pos` currently duplicates its own tiny `logger.ts`/
`health.ts` rather than depending on this package, to keep the very first commit low-risk.
Once `services/payments` is built (which genuinely needs the M-Pesa adapter interface
below), this package gets wired in as a real npm workspace dependency and `pos`'s local
copies get replaced with imports from here in the same PR.

## Contents

- `src/mpesa-adapter.ts` — the `MpesaAdapter` interface and `FakeMpesaAdapter`, the
  deterministic implementation CI and k6 run against. The real `DarajaMpesaAdapter` lands
  here alongside the Payments service.
- OTel setup and the Docker base pattern are not written yet — planned for when a second
  service (`payments`) needs identical ADOT wiring, so the shared code is extracted from a
  working example instead of designed speculatively.

## Docker base pattern (documented here, applied per-service)

Every service's `Dockerfile` follows the same shape rather than sharing a literal base
image (each service has different runtime deps, so a shared `FROM` stage would just be
`node:22-alpine` again):

1. `deps` stage: pinned `node:22.x-alpine`, `npm ci` from the repo-root lockfile.
2. `build` stage: `npm run build --workspace=@tillflow/<name>`.
3. `runtime` stage: copy only `node_modules` + compiled `dist/`, create a non-root user,
   `USER` to it, expose the port, add a `HEALTHCHECK` against `/health`.

See `services/pos/Dockerfile` for the first working instance of this pattern.
