# ADR-0006: Scope of the CI role's infrastructure-management permissions

## Status
Accepted — 2026-09-15

## Context
`devops-g5-ci-deploy` (the OIDC role GitHub Actions assumes, see `docs/adr/0005`) so far
only has narrow permissions for deploying the `pos` app: ECR push, a handful of ECS
actions, and a read-only API Gateway lookup for the smoke test. Running `terraform plan`
on every PR and a gated `terraform apply` on merge needs a much broader set: EC2 (VPC,
subnets, security groups, NAT/IGW/EIP, route tables), ELB, ECS, ECR, CloudWatch Logs, API
Gateway v2, IAM (to manage the task/exec/ci-deploy roles themselves), plus S3/DynamoDB for
the remote state backend.

This account is shared across the whole cohort, so handing a CI role this much power isn't
a decision to wave through without writing down the reasoning.

## Decision
- **One combined policy**, not split between "plan" and "apply" — `terraform plan` never
  mutates anything regardless of what the role *could* do, so the real gate on `apply` is
  the GitHub Environment approval step (see the `infra-apply` workflow), not a narrower IAM
  policy for plan-only runs.
- **EC2/ELB/ECS/ECR/Logs/API Gateway**: granted broadly (`resources = ["*"]`) within those
  service namespaces. Many of the mutating actions here (creating a VPC, a subnet, a
  security group rule) don't support resource-level ARN scoping at all in AWS's own IAM
  action reference, so a tighter policy would either be impossible to write correctly or
  would silently fail `terraform apply` partway through a real change. Bounded instead by:
  - A `aws:RequestedRegion` condition restricting every action to `eu-west-1` — this role
    can never touch another region in the shared account.
  - The trust policy from ADR-0005/0006-adjacent work already restricts *who* can assume
    this role to this repo's own workflows.
- **IAM is scoped tightly**, unlike the rest: role/policy actions are restricted to
  resources matching `arn:aws:iam::*:role/devops-g5-*` (and the matching inline-policy
  ARNs). This is the one service where broad access would be a real privilege-escalation
  risk (a role that can create/modify *any* IAM role can eventually grant itself anything),
  so this is the one boundary enforced by resource ARN rather than just a region condition.
- **Backend access** (S3 state bucket, DynamoDB lock table) is scoped to the exact ARNs
  from `infra/bootstrap`'s outputs, nothing broader.
- `infra/bootstrap` itself is deliberately **excluded** from CI's plan/apply — it stays a
  manually-run, rarely-changed stack (already documented as "apply this once, by hand" in
  its own header), so the CI role doesn't need KMS or bootstrap-specific permissions at all.

## Consequences
- This is a genuinely powerful role within `eu-west-1` for this account - broader than the
  brief's own examples might imply for a single "CI deploy role." That's a real trade-off,
  not an oversight: the alternative (hand-crafting resource-level ARN scoping for every EC2/
  ELB/ECS/API-Gateway action Terraform might ever call) isn't reliably achievable given how
  inconsistently AWS supports resource-level permissions across those services, and a policy
  that's wrong in a way that only surfaces mid-`apply` is worse than one that's honestly
  broad and documented as such.
- The region condition and the IAM scoping are the two concrete guardrails actually doing
  work here, not decoration - worth defending as the real answer if asked "why does this CI
  role have so much power."
