# ADR-0007: Tenant setup and the tenant-scoping validation boundary

## Status
Accepted — 2026-09-15

## Context
The brief calls out "contracts and validation boundaries" as an owned Product+POS decision,
specifically the risk in `docs/threat-model.md` (#3): a client-supplied `tenant_id` must
never be trusted on its own, since that's the direct path to one tenant reading or writing
another tenant's sales, attendants, or till config. POS needs *some* caller identity before
any of that scoping can be enforced, and there's no session/SSO system to lean on yet.

## Decision
- **Tenant bootstrap**: `POST /tenants` creates a tenant plus its first attendant with role
  `owner`, and returns a **raw API key exactly once** in the response body. Only the hash
  (`sha256`) is ever stored — the same principle as a password, not because the threat
  model is identical, but because a leaked database dump shouldn't hand out live
  credentials.
- **Every subsequent request** authenticates via `Authorization: Bearer <key>`. The API key
  is looked up, and it resolves to exactly one `tenant_id` and one `role` — that's the
  *only* source of truth for which tenant a request acts on. A request body or path
  parameter's `tenantId` is checked *against* the authenticated tenant, never trusted
  instead of it. This is the concrete implementation of threat #3's mitigation.
- **Roles**: `owner` (can manage attendants and tills for their tenant) and `attendant`
  (can record sales, cannot manage tenant configuration). Enough to satisfy "tenant-scoped
  roles" without building a general-purpose permissions system nobody asked for yet.
- **Commission rate** lives on the till (`commission_rate_bps`, basis points — e.g. 500 =
  5.00% — integer, no floating point, consistent with the brief's "integer minor units"
  rule for money-adjacent values).

## Consequences
- This is deliberately minimal — no password login, no session expiry, no key rotation
  endpoint yet. Fine for a capstone's current scope; a real product would need at least key
  rotation and per-key scoping (e.g. a narrower key for a specific till).
- Every table that holds tenant-owned data carries `tenant_id`, and every query is scoped
  by the *authenticated* tenant_id from the resolved API key, never a client-supplied one -
  this is the thing to actually test (see the invariant tests planned alongside sale
  recording), not just assert in this ADR.
