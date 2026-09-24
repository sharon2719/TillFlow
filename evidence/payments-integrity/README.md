TENANT_JSON=$(curl -fsS -X POST "$BASE_URL/tenants" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Evidence Duka 2","ownerName":"Gatchang","ownerMsisdn":"254708374149"}')

export TENANT_ID=$(printf '%s' "$TENANT_JSON" | jq -r '.tenantId')
export API_KEY=$(printf '%s' "$TENANT_JSON" | jq -r '.apiKey')

printf 'Tenant: %s\n' "$TENANT_ID"# Evidence — payments-integrity

This folder contains the live runtime proof for the Daraja / payments integrity work.

## Included proof

- `daraja-sandbox-verification-2026-09-16.md` — live Daraja sandbox verification and callback behavior
- `money-path-invariants-2026-09-18.md` — deterministic invariant tests for timeout, replay-safety, and no-double-pay behavior
- `end-to-end-demo-2026-09-18.md` — end-to-end demo transcript and narrative proof
- `payments-test-output-2026-09-18.txt` — raw output for the payments invariant test suite
- `commission-test-output-2026-09-18.txt` — raw output for the commission invariant test suite
- `shared-test-output-2026-09-18.txt` — raw output for the shared invariant test suite
- `k6-daraja-contract-2026-09-17.txt` — contract-style Daraja check against the live deployment
- [`cloudwatch.png`](./cloudwatch.png) — captured CloudWatch observability screenshot from the live payments-integrity evidence run
- [`grafana.png`](./grafana.png) — captured Grafana observability screenshot from the live payments-integrity evidence run

These files are the actual evidence behind the payments-integrity gate and should be treated as the source of truth for that area.
