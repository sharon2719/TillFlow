# ADR-0001: Service language and runtime

## Status
Accepted — 2026-09-14

## Context
Four backend surfaces (`pos`, `payments`, `commission`, `web`) need to ship fast, solo, on
ECS Fargate, with first-class AWS SDK support, straightforward OTel instrumentation, and a
test story that doesn't require heavyweight tooling to set up.

## Decision
- **Runtime:** Node.js 22 (LTS), TypeScript in strict mode.
- **HTTP framework:** Express — minimal, well understood, trivial to front with an ADOT
  auto-instrumentation layer later.
- **Logging:** `pino`, JSON output only, one field set across services (see
  `services/_shared` once extracted) so log-based alerting and trace correlation stay
  consistent.
- **Testing:** `vitest` + `supertest` for HTTP-level tests; no separate test runner per
  service.
- **Monorepo mechanics:** native npm workspaces (`services/*`). No Nx/Turborepo/Lerna —
  solo and four services doesn't justify the extra tool surface.
- **Package manager:** npm (ships with Node, no extra install, lockfile is
  straightforward to audit in CI).

## Consequences
- Every service shares one `package-lock.json` at the repo root; a Docker build for any
  single service must use the repo root as build context (`docker build -f
  services/<name>/Dockerfile .`), not the service directory.
- Cross-service shared code (`services/_shared`) is added as a real workspace once a second
  service needs it (payments/commission, for the M-Pesa adapter interface) rather than
  speculatively wired now.
- Coverage/lint gates in CI run per-workspace via `--workspace` filtering, which also gives
  the required path-filtered "only rebuild what changed" behavior for free.
