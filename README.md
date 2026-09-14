# TillFlow

Multi-tenant POS + M-Pesa (Daraja) payments, on AWS ECS. Solo capstone build — see
`docs/ownership.md` for why every area still names one DRI even with a group of one.

## Status (2026-09-14)

Repo just bootstrapped. Working: `services/pos` health/readiness skeleton, tested and
Dockerized. Everything else in the architecture (`docs/architecture.md`) is still to be
built — this README will be updated as each gate lands, not written once at the end.

## Prerequisites

- Node.js 22, npm 10+
- Docker
- Terraform ~1.15 (infra not yet written)
- An AWS account with credentials configured for `af-south-1` (see `docs/adr/0002-region.md`)

## Bootstrap / run locally

```bash
npm install
npm run typecheck --workspace=@tillflow/pos
npm run test --workspace=@tillflow/pos
npm run dev --workspace=@tillflow/pos   # http://localhost:3000/health
```

## Build the pos image

```bash
docker build -f services/pos/Dockerfile -t tillflow-pos:local .
docker run --rm -p 3000:3000 tillflow-pos:local
```

## Repo layout

See the brief's required mono-repo layout, reproduced as-built in
`docs/architecture.md`. Short version:

```
services/    pos, payments, commission, web, _shared
infra/       Terraform (not started)
.github/     CI (pos-only pipeline so far)
docs/        ownership, architecture, ADRs, SLOs, threat model
evidence/    per-area runtime proof (empty placeholders for now)
```

## Gates

Tracked outside this repo for now; see `docs/ownership.md` and the ADRs for what's decided.
G0 documents (this commit) are in place; G1 (Terraform + golden path) is next.

## Cost / cleanup

Nothing deployed to AWS yet — no cost, nothing to tear down.
