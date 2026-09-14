# ADR-0002: AWS region

## Status
Accepted — 2026-09-15

## Context
The brief requires deploying only in "your assigned Region" and documenting why in an ADR.
This isn't actually a free choice: it's fixed by the AWS SSO role the cohort issued —
`AWSReservedSSO_DevOpsCohort-group5-eu-west-1_...` — which also confirms the group number
(5) that `devops-g<N>` resource naming should use, and the account (`240462142849`).

An earlier draft of this ADR proposed af-south-1 on the reasoning that it's geographically
closest to EAT/Daraja traffic. That reasoning no longer applies now that the region is
externally assigned rather than chosen — the earlier version was wrong and is replaced by
this one, not extended.

## Decision
Deploy to **eu-west-1 (Ireland)** — the cohort-assigned region for group 5, confirmed via
the SSO role name and `aws sts get-caller-identity`.

eu-west-1 is one of AWS's original, fully-built-out regions, so unlike the af-south-1 draft
there's no open question about service availability: ECS Fargate, ALB, API Gateway (REST +
VPC Link), RDS for PostgreSQL, ElastiCache, SQS/DLQ, EventBridge, S3, DynamoDB, Secrets
Manager, KMS, ECR (with enhanced scanning), and X-Ray are all available without exception.

## Consequences
- Higher latency to Daraja/EAT users than a closer region would have, but that trade-off
  isn't TillFlow's to make — the assignment fixes the region, and the honest answer in the
  live defence is "cohort-assigned," not a latency optimization.
- No fallback-region contingency needed (unlike the af-south-1 draft's open TODO) — every
  required service is available here.
- All resource names and tags use `devops-g5-` per `docs/adr/0004-object-storage.md`.
