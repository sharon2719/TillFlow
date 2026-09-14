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
      values = [
        "repo:sharon2719/tillflow:*",     # classic form, no immutable IDs
        "repo:sharon2719@*/tillflow@*:*", # immutable-ID form
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
    resources = [aws_ecr_repository.pos.arn]
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
    ]
    resources = ["*"] # ECS describe/register actions don't support resource-level scoping consistently
  }

  statement {
    sid       = "PassEcsRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.pos_exec.arn, aws_iam_role.pos_task.arn]
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
