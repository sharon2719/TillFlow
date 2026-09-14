# ADR-0002: AWS region

## Status
Proposed — 2026-09-14 (confirm against the current AWS region/service list before the
G1 Terraform apply; service availability in af-south-1 shifts over time).

## Context
TillFlow's users (till attendants, tenant owners) and its one hard external dependency,
the Safaricom Daraja API, are East Africa Time (EAT). AWS has no region physically in East
Africa. The brief requires every resource to declare and justify a single region.

## Decision
Deploy to **af-south-1 (Cape Town)** — the AWS region geographically closest to EAT
traffic and to Daraja's endpoints, rather than defaulting to us-east-1 or eu-west-1.

Required services must all be available in af-south-1 before this ADR can be marked
Accepted:
- ECS Fargate, ALB, API Gateway (REST + VPC Link)
- RDS for PostgreSQL, ElastiCache (Redis/Valkey)
- SQS (+ DLQ), EventBridge
- S3, DynamoDB (state lock), Secrets Manager, KMS
- ECR with enhanced scanning
- X-Ray

## Consequences
- Higher per-unit pricing than us-east-1 in some service categories; acceptable trade for
  latency to Daraja and EAT users, and it's the honest answer to "why this region" in the
  live defence.
- Fewer Availability Zones to choose from than a larger region — confirm at least two AZs
  are usable for the required Multi-AZ RDS + private-subnet ECS layout before G1.
- CI/CD roles (OIDC, CodePipeline) are scoped to this single region only.

## Follow-up before Accepted
- [ ] Verify every service above is actually orderable in af-south-1 for this AWS account
      (some services roll out to newer regions later than others).
- [ ] If any required service is unavailable, fall back to eu-west-1 (Ireland) as the next
      closest fully-supported region and update this ADR with the reason.
