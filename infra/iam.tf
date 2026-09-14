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
      values   = ["repo:sharon2719/tillflow:*"]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = "${var.name_prefix}-ci-deploy"
  assume_role_policy = data.aws_iam_policy_document.ci_deploy_assume.json
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
}

resource "aws_iam_role_policy" "ci_deploy" {
  name   = "${var.name_prefix}-ci-deploy"
  role   = aws_iam_role.ci_deploy.id
  policy = data.aws_iam_policy_document.ci_deploy_permissions.json
}
