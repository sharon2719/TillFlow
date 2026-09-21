# Reformats every alert that reaches the SNS topic in infra/monitoring.tf into the
# structured Slack contract the brief asks for (environment, service, symptom, impact,
# value, panel, runbook link, owner, first safe action) - see
# infra/lambda/slack-notifier/index.mjs for the actual formatting logic. Email (the existing
# SNS subscription) keeps working exactly as before; this adds Slack alongside it, it
# doesn't replace anything.

# A real external credential (the webhook URL is effectively a bearer token for posting to
# a specific Slack channel) - same pattern as the Daraja credentials in ecs-payments.tf:
# Terraform manages the secret container only, never the real value. Starts as "unset" and
# stays that way until a real Slack incoming webhook is created and its URL pushed via
# `aws secretsmanager put-secret-value`, same out-of-band handoff as Daraja's credentials.
resource "aws_secretsmanager_secret" "slack_webhook_url" {
  name = "${var.name_prefix}-slack-webhook-url"

  tags = {
    service = "platform"
  }
}

resource "aws_secretsmanager_secret_version" "slack_webhook_url" {
  secret_id     = aws_secretsmanager_secret.slack_webhook_url.id
  secret_string = "unset"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Duplicate Slack posts confirmed live, root-caused before fixing rather than guessed at:
# a single isolated real alarm transition produced two genuinely distinct SNS MessageIds
# (ruled out "SNS redelivering the same message" - each one successfully claimed its own
# dedup slot). The real source is EventBridge's own at-least-once delivery from
# infra/alarm-eventbridge-bridge.tf's rule to its SNS target - a retry there produces a
# brand-new SNS Publish with a new MessageId but identical content. So this table keys on a
# hash of the message CONTENT, not the SNS envelope ID - see
# infra/lambda/slack-notifier/index.mjs's claimMessage(). Same dedup shape
# services/commission/src/worker.ts already uses for its own at-least-once SQS delivery,
# just keyed differently since the duplication source here isn't the same one. TTL keeps it
# small - duplicate deliveries happen within seconds of each other in practice, an hour is
# generous headroom, not a guess at the real window.
resource "aws_dynamodb_table" "slack_notifier_dedup" {
  name         = "${var.name_prefix}-slack-notifier-dedup"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "contentHash"

  attribute {
    name = "contentHash"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    service = "platform"
  }
}

data "archive_file" "slack_notifier" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/slack-notifier"
  output_path = "${path.module}/.build/slack-notifier.zip"
}

data "aws_iam_policy_document" "slack_notifier_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "slack_notifier" {
  name               = "${var.name_prefix}-slack-notifier"
  assume_role_policy = data.aws_iam_policy_document.slack_notifier_assume.json

  tags = {
    service = "platform"
  }
}

resource "aws_iam_role_policy_attachment" "slack_notifier_logs" {
  role       = aws_iam_role.slack_notifier.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "slack_notifier_secret" {
  statement {
    sid       = "ReadSlackWebhookSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.slack_webhook_url.arn]
  }
}

resource "aws_iam_role_policy" "slack_notifier_secret" {
  name   = "${var.name_prefix}-slack-notifier-secret"
  role   = aws_iam_role.slack_notifier.id
  policy = data.aws_iam_policy_document.slack_notifier_secret.json
}

data "aws_iam_policy_document" "slack_notifier_dedup" {
  statement {
    sid       = "DedupSlackNotifications"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.slack_notifier_dedup.arn]
  }
}

resource "aws_iam_role_policy" "slack_notifier_dedup" {
  name   = "${var.name_prefix}-slack-notifier-dedup"
  role   = aws_iam_role.slack_notifier.id
  policy = data.aws_iam_policy_document.slack_notifier_dedup.json
}

resource "aws_cloudwatch_log_group" "slack_notifier" {
  name              = "/aws/lambda/${var.name_prefix}-slack-notifier"
  retention_in_days = 14

  tags = {
    service = "platform"
  }
}

resource "aws_lambda_function" "slack_notifier" {
  function_name    = "${var.name_prefix}-slack-notifier"
  role             = aws_iam_role.slack_notifier.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.slack_notifier.output_path
  source_code_hash = data.archive_file.slack_notifier.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      SLACK_WEBHOOK_SECRET_ARN = aws_secretsmanager_secret.slack_webhook_url.arn
      ENVIRONMENT_NAME         = "production"
      DASHBOARD_URL            = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.overview.dashboard_name}"
      RUNBOOK_URL              = "https://github.com/sharon2719/TillFlow/blob/master/docs/runbook.md"
      DEDUP_TABLE_NAME         = aws_dynamodb_table.slack_notifier_dedup.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.slack_notifier]

  tags = {
    service = "platform"
  }
}

resource "aws_lambda_permission" "allow_sns" {
  statement_id  = "AllowAlertsTopicInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "slack_notifier" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.slack_notifier.arn
}
