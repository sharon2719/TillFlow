# ADR-0005: What not to touch in a shared cohort AWS account

## Status
Accepted — 2026-09-15

## Context
Account `240462142849` is shared across the whole DevOps cohort, not dedicated to group 5
(the `devops-g<N>` naming/tagging convention exists specifically to let multiple groups
coexist in it safely). Some AWS resources are account-wide singletons rather than
per-resource — creating or reconfiguring one of these from this group's Terraform can
collide with another group's state, or get silently fought over across independent applies.
Two were found while building the ECS golden path:

1. **GitHub OIDC provider** (`token.actions.githubusercontent.com`) — only one can exist
   per URL per AWS account. Confirmed via `aws iam list-open-id-connect-providers` that one
   already exists (likely course-provisioned, or created by another group first).
2. **ECR registry scanning configuration** — configured once per registry (effectively per
   account/region), not per repository. Confirmed via `aws ecr get-registry-scanning-configuration`
   that it's currently `BASIC`, account-wide, with no rules.

## Decision
- The OIDC provider is referenced via `data "aws_iam_openid_connect_provider"` in
  `infra/iam.tf`, never created. The IAM role that trusts it (`devops-g5-ci-deploy`) has a
  trust-policy condition scoped to `repo:sharon2719/tillflow:*` specifically, so this role
  can only ever be assumed by this repo's workflows — the shared provider is safe to trust
  broadly because each group's own role narrows who can actually use it.
- Registry-wide ECR scanning is left untouched. Per-repository `scan_on_push = true` (basic
  scanning) is used instead for `devops-g5/pos`, which is scoped to just that repository and
  can't be reverted by someone else's apply. If the registry is later switched to `ENHANCED`
  account-wide by a course admin, this repository benefits automatically with no Terraform
  change needed here.
- More generally: before adding any resource type that sounds account/region-wide rather
  than resource-specific (OIDC providers, registry-level config, default VPC settings,
  account-level GuardDuty/Security Hub enrollment, etc.), check with a read-only AWS CLI
  call first whether it already exists before deciding whether to manage or reference it.

## Consequences
- This group's Terraform can never accidentally break another group's CI/CD trust
  relationship or scanning posture.
- A few account-wide security postures (enhanced scanning, in particular) are outside this
  group's control to improve unilaterally — logged as a known limitation, not silently
  ignored.
