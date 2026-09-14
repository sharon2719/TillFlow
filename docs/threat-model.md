# Threat model (draft)

Scope: TillFlow's POS + payments + commission system, as described in
`docs/architecture.md`. STRIDE-style pass over the request path and trust boundaries.
Draft — to be refined before the G0 defence and re-checked at G4.

## Assets

- Daraja API credentials (consumer key/secret, initiator password) — highest value, direct
  path to real money movement.
- Tenant and attendant PII (names, phone numbers used for M-Pesa).
- Sale and payment/payout records — integrity matters more than confidentiality here.
- Slack webhook URL, DB credentials — operational secrets, not financial, but a foothold.

## Trust boundaries

1. Public internet → API Gateway (untrusted input, no assumption of good faith).
2. API Gateway → ALB → ECS services (assumed trusted network, but tenant identity is
   still just a claim in a request until verified against auth).
3. Services → RDS / ElastiCache / SQS (trusted, but each service must only reach its own
   schema/queue — a compromised POS task should not be able to read Payments' table).
4. Payments service → Daraja (external, adversarial-by-default: callbacks can be replayed,
   reordered, or spoofed by anyone who can reach the callback URL, not just Safaricom).

## Top threats and mitigations

| # | Threat | STRIDE | Mitigation |
|---|---|---|---|
| 1 | Forged/replayed Daraja callback used to mark an unpaid sale as paid, or to trigger a second payout | Spoofing, Tampering | Validate callback source/shape strictly; treat callbacks as idempotent by transaction ID; a callback can only move a payment through one legal state transition (see G2 replay tests) |
| 2 | Attacker retries a timed-out STK/B2C request expecting a duplicate charge/payout | Repudiation | Idempotency keys on every money-mutating request; a timeout is stored as "pending", resolved only by query/reconciliation, never re-originated blindly |
| 3 | Cross-tenant data access (tenant A reads/writes tenant B's sales or attendants) | Information disclosure, Elevation of privilege | Every query scoped by authenticated tenant_id, never by a client-supplied tenant_id alone; tested explicitly, not just implied by the schema |
| 4 | Daraja credentials or DB credentials leaked via logs, Terraform state, or a build log | Information disclosure | Secrets Manager only; JSON log fields are allow-listed, never a raw request/response dump; `SLACK_WEBHOOK_URL` and all secrets excluded from Git, state and CI logs per the brief |
| 5 | Commission worker compromised or bugged into calling Daraja directly, bypassing Payments' idempotency/reconciliation logic | Elevation of privilege, Tampering | Architectural boundary: Commission has no Daraja credentials or network path to Daraja at all, only an internal call to Payments' B2C endpoint — enforced by IAM/security-group scoping, not just code convention |
| 6 | Overly broad IAM roles let a compromised task pivot to unrelated AWS resources | Elevation of privilege | Per-service least-privilege task roles, one per service, scoped to only that service's schema/queue/secret |
| 7 | A broken release silently ships bad money logic | Tampering | Post-deploy smoke tests gate promotion; ECS rollback path proven in G4, not just documented |

## Out of scope for this pass

Web application session/auth mechanics beyond tenant scoping (to be detailed once
`services/web` exists), physical device security for the till hardware, and Safaricom-side
Daraja security (out of TillFlow's control).
