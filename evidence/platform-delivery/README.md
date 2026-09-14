# Evidence — platform-delivery

## Naming + tag audit

Script: `infra/scripts/audit_naming_tags.py`. Reproduce with:

```bash
python infra/scripts/audit_naming_tags.py --region eu-west-1 --prefix devops-g5
```

Requires `aws` CLI authenticated in the shell it's run from (whatever profile/session is
already active — the script shells out to `aws`, it doesn't manage credentials).

Uses the AWS Resource Groups Tagging API to find every resource tagged `capstone=tillflow`,
plus a direct IAM role check (that API has historically had gaps for IAM). For each
resource: checks the six required tags (`group`, `owner`, `environment`, `service`,
`managed-by`, `capstone`) and that it's named with the `devops-g5-` prefix — checking the
`Name` tag instead of the raw ID for resource types whose identifier is an AWS-assigned
opaque string (`vpc-xxxx`, `sg-xxxx`, KMS key IDs, API Gateway's short IDs, ...), and
skipping the naming check entirely for individual security-group *rules*, which don't have
a meaningful name of their own in this account's actual naming convention.

Latest run: `naming-tag-audit-2026-09-15.txt` — 43 resources checked, 3 failing. All 3
failures are pre-existing IAM roles (`devops-g5-iac-ecs-execution-role`,
`devops-g5-iac-ecs-task-role`, `devops-g5-iac-gha-deploy`) created 2026-08-28, three weeks
before this repo existed, unmanaged by this repo's Terraform and untagged entirely — not a
gap in anything this project built. Pending a decision on whether to delete them.

Along the way, running this for real (rather than trusting the code to be right) surfaced
and led to fixing:
- Two real script bugs (API Gateway ARNs have an unusual empty-account-segment shape;
  ELB ARNs nest the actual resource name a level deeper than a plain first-slash split
  expects) — both corrected in the script itself, not worked around.
- Several genuine tagging gaps: `infra/bootstrap`'s provider was missing `owner` and
  `environment` from its `default_tags` entirely; seven standalone security-group rule
  resources, the ALB listener, and three IAM roles had no `service` tag; three API Gateway
  resources had no `Name` tag to check against (their actual `name` property isn't exposed
  by the tagging API, only tags are).
- A separate, unrelated discovery while touching `infra/bootstrap`: its local Terraform
  state file no longer existed on disk (lost during an earlier project folder move), while
  the real AWS resources it manages were still there and fine. Recovered via
  `terraform import` for all seven resources rather than risk `terraform apply` creating
  duplicates against a plan that thought nothing existed yet.
- Two IDE-linter findings caught while editing `infra/bootstrap/main.tf` for tags, fixed
  since they were cheap: an HTTPS-only bucket policy on the tfstate bucket, and
  point-in-time-recovery + a customer-managed KMS key on the lock table (closing out two
  items that were previously logged as accepted risk in `docs/production-readiness.md`).
