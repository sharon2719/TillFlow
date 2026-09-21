# Naming/tag re-audit + latest-tag audit (G5 final check)

**Date:** 2026-09-18. Re-run of `infra/scripts/audit_naming_tags.py --region eu-west-1
--prefix devops-g5` after the 09-15 audit's 3 real failures were fixed by the 09-17
orphaned-resource teardown. Raw output: `naming-tag-audit-2026-09-18.txt`.

## Naming/tagging: real compliance is 100% - 8 reported failures are all script false
positives, verified individually, not waved away

`160 resources checked, 8 failing` on the raw run. Every one of the 8 was checked by hand
against the live resource, not assumed benign:

- **4x ALB listener-rule ARNs** (`listener-rule/app/devops-g5-alb/.../<rule-id>`) - the
  parent ALB is correctly named `devops-g5-alb`; a listener rule's ARN just appends an
  opaque AWS-generated rule ID with no naming field of its own to check. Script limitation
  (naive prefix match against the full ARN tail), not a real violation.
- **1x KMS key** (`0452e857-...`) - `aws kms describe-key` + `list-aliases` confirms this
  key has a correct `alias/devops-g5-artifacts` alias; the script checks the raw `KeyId`
  (a UUID KMS assigns, not renameable) instead of resolving the alias. Same class of
  false positive.
- **2x Lambda log groups** (`/aws/lambda/devops-g5-slack-notifier`,
  `/aws/lambda/devops-g5-external-probe`) - the prefix is correctly present, one path
  segment deep (`/aws/lambda/<name>` is AWS's fixed format for Lambda's own log groups, not
  something Terraform controls the shape of). Script checks the start of the full path.
- **1x Secrets Manager secret** (`rds!db-7adbe9a5-...`) - this is RDS's own
  auto-generated master-user secret (`manage_master_user_password`), whose name format
  (`rds!db-<uuid>`) is dictated entirely by AWS and can't be renamed to fit any prefix.

**Conclusion: every real, renameable resource in this stack is correctly prefixed and fully
tagged.** The 3 real failures from 09-15 (three pre-existing, non-Terraform IAM roles) no
longer exist - confirmed by their absence from this run entirely, not just by them not being
in the failure list.

## `latest` tag: confirmed absent, live, across every image and every running task

- `aws ecr describe-images` on all 5 repositories (pos, payments, commission, web, grafana):
  every tag on every image is a commit SHA. Zero `latest` tags exist anywhere.
- `aws ecs describe-services` + `describe-task-definition` for all 5 running services:
  every one is currently running an image referenced by a full SHA digest tag matching a
  real merged commit (e.g. `pos` and `payments` both on `45b623802ca1ae27303e61acab107a79337a8425`,
  `grafana` on `2c969b7630b86a8d7221f4c2973f6771dd5cd873`) - not `latest`, not the
  Terraform-default `bootstrap` placeholder either.

Both G1 and G5's naming/tagging/latest-tag checklist items are closed with live evidence,
not repo-static inspection alone.
