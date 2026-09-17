# --- ECS task execution role: pulls the image from ECR, writes container logs to
# CloudWatch. Standard AWS-managed policy covers both; nothing custom needed yet. ---

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pos_exec" {
  name               = "${var.name_prefix}-pos-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "pos"
  }
}

resource "aws_iam_role_policy_attachment" "pos_exec_managed" {
  role       = aws_iam_role.pos_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# --- ECS task role: what the running containers (pos app + ADOT sidecar) can call. The
# ADOT collector needs to write metrics/logs to CloudWatch and traces to X-Ray - both
# standard AWS-managed policies for exactly this sidecar pattern. Nothing app-specific
# (DB/secrets access) yet, since pos has neither wired in. ---

resource "aws_iam_role" "pos_task" {
  name               = "${var.name_prefix}-pos-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "pos"
  }
}

resource "aws_iam_role_policy_attachment" "pos_task_cloudwatch" {
  role       = aws_iam_role.pos_task.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "pos_task_xray" {
  role       = aws_iam_role.pos_task.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# The RDS master credential is AWS-managed (manage_master_user_password = true in
# infra/rds.tf) - it lives in a Secrets Manager secret Terraform never sees the value of.
# This goes on the EXECUTION role, not the task role: ECS's native `secrets` field on a
# container definition (see ecs-task-def.tf) is resolved by the execution role at container
# startup, before the app code (and its task role) ever runs.
data "aws_iam_policy_document" "pos_exec_db_secret" {
  statement {
    sid       = "ReadDbSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
}

resource "aws_iam_role_policy" "pos_exec_db_secret" {
  name   = "${var.name_prefix}-pos-exec-db-secret"
  role   = aws_iam_role.pos_exec.id
  policy = data.aws_iam_policy_document.pos_exec_db_secret.json
}

# --- payments: same three-role pattern as pos (exec pulls image + resolves the DB secret,
# task role gets CloudWatch/X-Ray for the ADOT sidecar). ---

resource "aws_iam_role" "payments_exec" {
  name               = "${var.name_prefix}-payments-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "payments"
  }
}

resource "aws_iam_role_policy_attachment" "payments_exec_managed" {
  role       = aws_iam_role.payments_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "payments_task" {
  name               = "${var.name_prefix}-payments-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "payments"
  }
}

resource "aws_iam_role_policy_attachment" "payments_task_cloudwatch" {
  role       = aws_iam_role.payments_task.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "payments_task_xray" {
  role       = aws_iam_role.payments_task.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

data "aws_iam_policy_document" "payments_exec_db_secret" {
  statement {
    sid       = "ReadDbSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "ReadDarajaCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.daraja_credentials.arn]
  }
}

resource "aws_iam_role_policy" "payments_exec_db_secret" {
  name   = "${var.name_prefix}-payments-exec-db-secret"
  role   = aws_iam_role.payments_exec.id
  policy = data.aws_iam_policy_document.payments_exec_db_secret.json
}

# --- commission: same pattern again. ---

resource "aws_iam_role" "commission_exec" {
  name               = "${var.name_prefix}-commission-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "commission"
  }
}

resource "aws_iam_role_policy_attachment" "commission_exec_managed" {
  role       = aws_iam_role.commission_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "commission_task" {
  name               = "${var.name_prefix}-commission-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "commission"
  }
}

resource "aws_iam_role_policy_attachment" "commission_task_cloudwatch" {
  role       = aws_iam_role.commission_task.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "commission_task_xray" {
  role       = aws_iam_role.commission_task.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

data "aws_iam_policy_document" "commission_exec_db_secret" {
  statement {
    sid       = "ReadDbSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
}

resource "aws_iam_role_policy" "commission_exec_db_secret" {
  name   = "${var.name_prefix}-commission-exec-db-secret"
  role   = aws_iam_role.commission_exec.id
  policy = data.aws_iam_policy_document.commission_exec_db_secret.json
}

# --- web: same exec/task role pattern, minus the DB secret grant - web has no database of
# its own (see infra/ecs-web.tf), so its exec role only needs the managed policy every
# execution role gets (ECR pull + CloudWatch Logs). Its SESSION_SECRET (infra/ecs-web.tf) is
# a Terraform `random_password`, passed as a plain task-def env var rather than an AWS
# Secrets Manager secret - it only signs a session cookie carrying the caller's own API key,
# so keeping it out of Secrets Manager trades a small, accepted exposure (visible to anyone
# who can already describe this task definition) for not widening the ci-deploy-infra role's
# IAM policy with secretsmanager:Create*/PutSecretValue for one non-critical value. ---

resource "aws_iam_role" "web_exec" {
  name               = "${var.name_prefix}-web-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "web"
  }
}

resource "aws_iam_role_policy_attachment" "web_exec_managed" {
  role       = aws_iam_role.web_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "web_task" {
  name               = "${var.name_prefix}-web-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "web"
  }
}

resource "aws_iam_role_policy_attachment" "web_task_cloudwatch" {
  role       = aws_iam_role.web_task.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "web_task_xray" {
  role       = aws_iam_role.web_task.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# --- grafana: exec role resolves the admin-password secret (aws_secretsmanager_secret.
# grafana_admin_password lives in infra/ecs-grafana.tf); task role is read-only against
# CloudWatch/X-Ray/CloudWatch Logs Insights - it's a dashboard consumer, nothing it displays
# is writable through this role. No CloudWatchAgentServerPolicy/XRayDaemonWriteAccess like
# the other four - those are for a task that WRITES telemetry (the ADOT sidecar pattern),
# which grafana doesn't run (see infra/cloudwatch.tf's comment on why there's no
# grafana_adot log group). ---

resource "aws_iam_role" "grafana_exec" {
  name               = "${var.name_prefix}-grafana-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "grafana"
  }
}

resource "aws_iam_role_policy_attachment" "grafana_exec_managed" {
  role       = aws_iam_role.grafana_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "grafana_exec_admin_secret" {
  statement {
    sid       = "ReadGrafanaAdminSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.grafana_admin_password.arn]
  }
}

resource "aws_iam_role_policy" "grafana_exec_admin_secret" {
  name   = "${var.name_prefix}-grafana-exec-admin-secret"
  role   = aws_iam_role.grafana_exec.id
  policy = data.aws_iam_policy_document.grafana_exec_admin_secret.json
}

resource "aws_iam_role" "grafana_task" {
  name               = "${var.name_prefix}-grafana-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    service = "grafana"
  }
}

data "aws_iam_policy_document" "grafana_task_read_observability" {
  statement {
    sid = "CloudWatchReadOnly"
    actions = [
      "cloudwatch:DescribeAlarms",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:GetDashboard",
      "cloudwatch:ListDashboards",
      "cloudwatch:ListMetrics",
      "cloudwatch:ListTagsForResource",
    ]
    resources = ["*"] # CloudWatch read actions don't support resource-level scoping
  }

  statement {
    sid = "LogsReadOnly"
    actions = [
      "logs:DescribeLogGroups",
      "logs:GetLogGroupFields",
      "logs:StartQuery",
      "logs:StopQuery",
      "logs:GetQueryResults",
      "logs:GetLogEvents",
    ]
    resources = ["*"]
  }

  statement {
    sid = "XRayReadOnly"
    actions = [
      "xray:GetTraceSummaries",
      "xray:BatchGetTraces",
      "xray:GetTraceGraph",
      "xray:GetServiceGraph",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "grafana_task_read_observability" {
  name   = "${var.name_prefix}-grafana-task-read-observability"
  role   = aws_iam_role.grafana_task.id
  policy = data.aws_iam_policy_document.grafana_task_read_observability.json
}

# --- GitHub Actions OIDC deploy role -------------------------------------------------
#
# This AWS account is shared across the whole cohort (docs/adr/0002-region.md), and an
# OIDC provider for token.actions.githubusercontent.com already exists account-wide
# (confirmed via `aws iam list-open-id-connect-providers` before writing this - creating a
# second one would fail, since only one can exist per URL per account). So this
# REFERENCES the existing provider rather than creating it, and the trust policy is scoped
# tightly to this repo only, so this role can never be assumed by another group's workflow.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "ci_deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # GitHub's newer OIDC claims append immutable numeric IDs to guard against subject
      # spoofing via repo rename/delete+recreate, e.g.
      # "repo:sharon2719@79141719/tillflow@1370048911:ref:refs/heads/master" instead of the
      # classic "repo:sharon2719/tillflow:ref:refs/heads/master". Confirmed via CloudTrail
      # (AssumeRoleWithWebIdentity AccessDenied events) that the immutable-ID form is what's
      # actually sent. Both patterns require the literal "@" right after the owner/repo name
      # (not a bare wildcard suffix) so this can't also match an unrelated account like
      # "sharon27190therorg".
      #
      # Also confirmed via CloudTrail: GitHub emits the repo name with inconsistent casing
      # depending on the triggering event - "tillflow" on push-triggered runs,
      # "TillFlow" on pull_request-triggered ones (same owner/repo IDs both times, so
      # definitely the same repo - this is a GitHub-side quirk, not two different repos).
      # StringLike has no case-insensitive form, so both castings are listed explicitly.
      values = [
        "repo:sharon2719/tillflow:*",     # classic form, no immutable IDs, lowercase
        "repo:sharon2719/TillFlow:*",     # classic form, no immutable IDs, PR casing
        "repo:sharon2719@*/tillflow@*:*", # immutable-ID form, lowercase
        "repo:sharon2719@*/TillFlow@*:*", # immutable-ID form, PR casing
      ]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = "${var.name_prefix}-ci-deploy"
  assume_role_policy = data.aws_iam_policy_document.ci_deploy_assume.json

  tags = {
    service = "platform"
  }
}

data "aws_iam_policy_document" "ci_deploy_permissions" {
  statement {
    sid = "EcrAuth"
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"] # GetAuthorizationToken has no resource-level permissions
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = [aws_ecr_repository.pos.arn, aws_ecr_repository.payments.arn, aws_ecr_repository.commission.arn, aws_ecr_repository.web.arn, aws_ecr_repository.grafana.arn]
  }

  statement {
    sid = "EcsDeploy"
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:RegisterTaskDefinition",
      "ecs:UpdateService",
      "ecs:ListTasks",
      "ecs:RunTask", # the one-off migration task in deploy-pos.yml
    ]
    resources = ["*"] # ECS describe/register actions don't support resource-level scoping consistently
  }

  statement {
    sid     = "PassEcsRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.pos_exec.arn, aws_iam_role.pos_task.arn,
      aws_iam_role.payments_exec.arn, aws_iam_role.payments_task.arn,
      aws_iam_role.commission_exec.arn, aws_iam_role.commission_task.arn,
      aws_iam_role.web_exec.arn, aws_iam_role.web_task.arn,
      aws_iam_role.grafana_exec.arn, aws_iam_role.grafana_task.arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # Read-only, for the post-deploy smoke test's `aws apigatewayv2 get-apis` lookup of the
  # public endpoint. API Gateway's IAM actions don't support scoping to a single API by ARN
  # for the *list* operation (GetApis lists across the account), so this is read-only
  # (no write actions) rather than resource-scoped.
  statement {
    sid       = "ApiGatewayReadForSmokeTest"
    actions   = ["apigateway:GET"]
    resources = ["arn:aws:apigateway:${var.region}::/apis", "arn:aws:apigateway:${var.region}::/apis/*"]
  }
}

# --- Terraform plan (every PR) + gated apply (on merge, behind a GitHub Environment
# approval - see .github/workflows/infra-apply.yml) for the main infra/ stack. See
# docs/adr/0006-ci-infra-permissions.md for why this is broad within these service
# namespaces rather than resource-scoped, and why IAM specifically is the one exception.
data "aws_iam_policy_document" "ci_deploy_infra" {
  statement {
    sid = "InfraServicesRegionScoped"
    actions = [
      "ec2:*",
      "elasticloadbalancing:*",
      "ecs:*",
      "ecr:*",
      "logs:*",
      "apigateway:*",
      "rds:*",         # added for infra/rds.tf (G2) - didn't exist when this statement was first written
      "cloudwatch:*",  # added for infra/monitoring.tf (G3) - alarms + dashboard
      "sns:*",         # added for infra/monitoring.tf (G3) - alarm topic + email subscription
      "elasticache:*", # added for infra/async.tf (G1) - Redis, no consumer wired up yet
      "sqs:*",         # added for infra/async.tf (G1) - commission-close queue + DLQ
      "scheduler:*",   # added for infra/async.tf (G1) - daily commission-close trigger
      "lambda:*",      # added for infra/slack-notifier.tf (G3) - the Slack alert Lambda
      "s3:*",          # added for infra/synthetics.tf (G3) - the artifacts bucket, first S3 use in this stack
      "kms:*",         # added for infra/synthetics.tf (G3) - the artifacts bucket's own CMK; the narrower TfstateKmsKey statement below still covers the pre-existing tfstate lock key specifically
      "events:*",      # added for infra/external-probe.tf (G3) - the one-minute external probe's EventBridge schedule
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  # The one place broad access would be a real privilege-escalation risk: scoped to only
  # this project's own role names, never arbitrary IAM resources in the shared account.
  statement {
    sid = "IamScopedToOwnRoles"
    actions = [
      "iam:GetRole",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:PassRole",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:aws:iam::240462142849:role/${var.name_prefix}-*"]
  }

  statement {
    sid       = "IamReadOidcProvider"
    actions   = ["iam:GetOpenIDConnectProvider"]
    resources = [data.aws_iam_openid_connect_provider.github.arn]
  }

  # The data source looks the provider up *by URL*, which AWS resolves via
  # ListOpenIDConnectProviders (an account-wide list, no resource-level scoping - "*" is
  # correct here, not a shortcut) before it can call Get on the specific ARN above.
  statement {
    sid       = "IamListOidcProviders"
    actions   = ["iam:ListOpenIDConnectProviders"]
    resources = ["*"]
  }

  # Backend access, scoped to the exact bucket/table from infra/bootstrap - never broader.
  statement {
    sid       = "TfstateBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.name_prefix}-tfstate-240462142849", "arn:aws:s3:::${var.name_prefix}-tfstate-240462142849/*"]
  }

  statement {
    sid       = "TflockTable"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = ["arn:aws:dynamodb:${var.region}:240462142849:table/${var.name_prefix}-tflock"]
  }

  # The tflock table (and the tfstate bucket) are encrypted with this customer-managed key
  # (infra/bootstrap/main.tf) rather than an AWS-managed default - added during the naming/
  # tag audit pass. That means every state lock/read now needs Decrypt on it too, which the
  # two statements above don't cover on their own. ARN is hardcoded the same way the bucket/
  # table names already are in infra/backend.tf - bootstrap is a separate Terraform stack
  # with no cross-stack data source wired up.
  statement {
    sid       = "TfstateKmsKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["arn:aws:kms:${var.region}:240462142849:key/0257835a-a3a1-487a-b740-79ea0b801eaf"]
  }

  # Scoped to just the one secret this stack creates (infra/ecs-grafana.tf) - Secrets
  # Manager supports resource-level ARN scoping even for Create* actions, via the
  # name-prefix wildcard pattern, so this never needs to widen to "secretsmanager:*"
  # (unlike elasticache:*/sqs:*/scheduler:* above, which don't support that).
  statement {
    sid = "GrafanaAdminSecret"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:GetResourcePolicy", # the AWS provider reads this on every plan/refresh, even with no resource policy attached
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
    ]
    resources = ["arn:aws:secretsmanager:${var.region}:240462142849:secret:${var.name_prefix}-grafana-admin-password-*"]
  }

  statement {
    sid = "DarajaCredentialsSecret"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
    ]
    resources = ["arn:aws:secretsmanager:${var.region}:240462142849:secret:${var.name_prefix}-daraja-credentials-*"]
  }

  statement {
    sid = "SlackWebhookSecret"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
    ]
    resources = ["arn:aws:secretsmanager:${var.region}:240462142849:secret:${var.name_prefix}-slack-webhook-url-*"]
  }
}

resource "aws_iam_role_policy" "ci_deploy_infra" {
  name   = "${var.name_prefix}-ci-deploy-infra"
  role   = aws_iam_role.ci_deploy.id
  policy = data.aws_iam_policy_document.ci_deploy_infra.json
}

resource "aws_iam_role_policy" "ci_deploy" {
  name   = "${var.name_prefix}-ci-deploy"
  role   = aws_iam_role.ci_deploy.id
  policy = data.aws_iam_policy_document.ci_deploy_permissions.json
}
