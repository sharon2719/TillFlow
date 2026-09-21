# POS API verification (G2)

Real test output (not summarized/paraphrased), run 2026-09-18 against `services/pos`'s own
suite (`pg-mem`-backed, no real Postgres needed to reproduce). Raw output:
`evidence/product-pos/pos-test-output-2026-09-18.txt`. Reproduce with:
`npm run test --workspace=@tillflow/pos`.

**Result: 22/22 tests passed, 4 test files.**

## What each G2 POS checklist item maps to, by file:line

**"POS API: tenant setup — till, attendants, commission rates, tenant-scoped roles"**
(`services/pos/src/routes/tenants.ts`, `services/pos/src/auth.ts`):
- `test/tenants.test.ts:31` — tenant creation returns a usable API key.
- `test/tenants.test.ts:47` — the owner configures a till with the returned key.
- `test/tenants.test.ts:67` — an invalid commission rate (outside 0-10000 bps) is rejected.
- `test/tenants.test.ts:81`, `:86` — no API key / an unknown API key are both rejected.
- `test/tenants.test.ts:91` — an owner can add an attendant; that attendant (role
  `"attendant"`, not `"owner"`) is then blocked from configuring tills - `requireOwner`
  actually enforces the role boundary, not just documents it.
- `test/tenants.test.ts:117` — one tenant can never see another tenant's tills, even with a
  syntactically valid API key - the tenant-scoping boundary from `docs/adr/0007` holds under
  test, not just by inspection.

**"POS API: sale recording in integer minor units, idempotent creation"**
(`services/pos/src/sales.ts`):
- `test/sales.test.ts:46` — a sale is created for the authenticated tenant, with
  `tenantId`/`attendantId` derived from the API key, never trusted from the request body
  (the exact threat `docs/threat-model.md` #3 describes).
- `test/sales.test.ts:77` — a sale with no `Idempotency-Key` header is rejected outright -
  there's no silent random-key fallback that would defeat the point of idempotency.
- `test/sales.test.ts:87` — a duplicate idempotency key is rejected without creating a
  second sale (both the check-first query and the DB's own `UNIQUE` constraint are real,
  exercised paths - see `services/pos/migrations/002_sales.sql` for the constraint).
- `test/sales.test.ts:120` — a `tillId` belonging to a *different* tenant is rejected, even
  though it's a syntactically valid till ID.

## The read-through auth cache added for G4 didn't regress any of the above

`test/auth-cache.test.ts` (4 tests, added alongside `services/pos/src/cache.ts`) proves the
Redis cache sitting in front of `requireAuth`'s DB lookup: populates on a cache miss, serves
from cache on a hit (with no second `pos.api_keys` query), and falls back to the DB
gracefully on a corrupt cache value or a throwing `Cache` implementation - the tenant-scoping
guarantees above hold whether or not the cache is involved in a given request.

## What this does *not* cover

Money-path invariants that span pos, payments and commission together (timeout-is-pending,
replay-safety, no-double-pay) are commission/payments' own responsibility and are covered in
`evidence/payments-integrity/`, not repeated here. This file is POS's own boundary: tenant
isolation, role enforcement, and idempotent sale recording in isolation.
