# ADR-0004: S3 bucket layout

## Status
Proposed — 2026-09-14

## Decision
One bucket per purpose, all private, all versioned, all encrypted with a customer-managed
KMS key, all with block-public-access on:

| Bucket | Purpose | Lifecycle |
|---|---|---|
| `devops-g<N>-tfstate-<account-id>` | Terraform remote state | Versioning on, never expires; noncurrent versions kept 90 days |
| `devops-g<N>-artifacts-<account-id>` | Pipeline/build artifacts, SBOMs | Expire after 30 days |
| `devops-g<N>-logs-<account-id>` | ALB access logs | Transition to Glacier at 30 days, expire at 180 days |
| `devops-g<N>-backups-<account-id>` | DB exports / restore-drill snapshots | Expire after 30 days (RDS automated backups are the real backup path; this bucket is for exported dumps used in restore drills) |
| `devops-g<N>-evidence-<account-id>` | Capstone evidence pack artifacts | Never expires |

The state bucket is paired with a DynamoDB table, `devops-g<N>-tflock`, for state locking.

`<N>` is the assigned group/account number — not yet known solo, so every reference in
Terraform and docs uses the `devops-g<N>-` prefix literally until it's assigned, at which
point a single variable substitution fixes every resource name at once.

## Consequences
- Five buckets to manage instead of one "just throw it all in one bucket" bucket — more
  IAM policy surface, but it makes the bucket policy audit (required proof for this ADR)
  trivial to write per-purpose instead of one sprawling policy.
- Bucket names must still be globally unique across all of AWS; the account ID suffix
  handles that once the account is provisioned.
