# One-minute external synthetic probe, run from outside the VPC entirely (unlike every
# other health signal in this stack, which observes from inside AWS) - the same path a real
# user's request takes: public internet -> API Gateway -> VPC Link -> ALB -> pos.
#
# A plain scheduled Lambda, not CloudWatch Synthetics - Synthetics canaries require a
# minimum of 960MB of Lambda memory (an AWS API-enforced constraint on the underlying
# Lambda function every canary runs as), but this shared cohort account caps every Lambda
# function's memory at 512MB. Confirmed live, not assumed: a real aws_synthetics_canary
# apply failed with `'MemorySize' value failed to satisfy constraint: Member must have
# value less than or equal to 512`, and the canary object it partially created was deleted
# again (see docs/production-readiness.md). Those two constraints are mutually exclusive in
# this account, so Synthetics literally cannot run here - this Lambda does the same job
# (external HTTP check on a schedule, emitting a signal to alarm on) within the account's
# real limits, via infra/lambda/external-probe/index.mjs.

# --- devops-g5-artifacts bucket (docs/adr/0004-object-storage.md) - planned from the start
# but never actually built until this work needed somewhere to eventually put pipeline
# artifacts/SBOMs. Kept even after the Synthetics pivot above - it's still the ADR's own
# planned bucket for that stated purpose, independent of what triggered building it first.
# Customer-managed KMS key per the ADR's explicit decision - unlike the SNS topic in
# monitoring.tf (a customer-managed key there risked silently breaking notification
# delivery), S3 SSE-KMS is a much more standard, low-risk pattern. ---

resource "aws_kms_key" "artifacts" {
  description         = "Encrypts devops-g5-artifacts (docs/adr/0004-object-storage.md)"
  enable_key_rotation = true

  tags = {
    service = "platform"
  }
}

resource "aws_kms_alias" "artifacts" {
  name          = "alias/${var.name_prefix}-artifacts"
  target_key_id = aws_kms_key.artifacts.key_id
}

# trivy:ignore:AWS-0089 -- accepted risk, owner sharon2719, revisit before G5; see docs/production-readiness.md (no second logging bucket for 30-day-expiring, non-sensitive SBOM/canary artifacts)
resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.name_prefix}-artifacts-240462142849"

  tags = {
    service = "platform"
  }
}

data "aws_iam_policy_document" "artifacts_https_only" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts_https_only" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.artifacts_https_only.json
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.artifacts.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-after-30-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# --- the probe Lambda itself ---

resource "aws_iam_role" "external_probe" {
  name               = "${var.name_prefix}-external-probe"
  assume_role_policy = data.aws_iam_policy_document.slack_notifier_assume.json # same lambda.amazonaws.com trust - reused, not duplicated

  tags = {
    service = "platform"
  }
}

resource "aws_iam_role_policy_attachment" "external_probe_logs" {
  role       = aws_iam_role.external_probe.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "external_probe_metrics" {
  statement {
    sid       = "PutProbeMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"] # PutMetricData has no resource-level scoping; narrowed by the namespace condition below instead
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["TillFlow/ExternalProbe"]
    }
  }
}

resource "aws_iam_role_policy" "external_probe_metrics" {
  name   = "${var.name_prefix}-external-probe-metrics"
  role   = aws_iam_role.external_probe.id
  policy = data.aws_iam_policy_document.external_probe_metrics.json
}

resource "aws_cloudwatch_log_group" "external_probe" {
  name              = "/aws/lambda/${var.name_prefix}-external-probe"
  retention_in_days = 14

  tags = {
    service = "platform"
  }
}

data "archive_file" "external_probe" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/external-probe"
  output_path = "${path.module}/.build/external-probe.zip"
}

resource "aws_lambda_function" "external_probe" {
  function_name    = "${var.name_prefix}-external-probe"
  role             = aws_iam_role.external_probe.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.external_probe.output_path
  source_code_hash = data.archive_file.external_probe.output_base64sha256
  timeout          = 15
  memory_size      = 128 # well within this account's 512MB Lambda ceiling - see file header

  environment {
    variables = {
      TARGET_URL = "${aws_apigatewayv2_api.main.api_endpoint}/health"
    }
  }

  depends_on = [aws_cloudwatch_log_group.external_probe]

  tags = {
    service = "platform"
  }
}

resource "aws_cloudwatch_event_rule" "external_probe_schedule" {
  name                = "${var.name_prefix}-external-probe-schedule"
  schedule_expression = "rate(1 minute)"

  tags = {
    service = "platform"
  }
}

resource "aws_cloudwatch_event_target" "external_probe" {
  rule = aws_cloudwatch_event_rule.external_probe_schedule.name
  arn  = aws_lambda_function.external_probe.arn
}

resource "aws_lambda_permission" "allow_eventbridge_probe" {
  statement_id  = "AllowExternalProbeSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.external_probe.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.external_probe_schedule.arn
}

# Alarms when the probe fails 3 consecutive minutes in a row (not a single blip - a public
# endpoint occasionally missing one 1-minute check isn't necessarily an outage, the same
# reasoning as the unhealthy-host alarms' 2-minute window in infra/monitoring.tf).
resource "aws_cloudwatch_metric_alarm" "external_probe_failing" {
  alarm_name          = "${var.name_prefix}-external-probe-failing"
  alarm_description   = "The external synthetic probe (outside the VPC) has failed 3 consecutive minutes - see docs/runbook.md"
  namespace           = "TillFlow/ExternalProbe"
  metric_name         = "ProbeSuccess"
  dimensions          = { Target = "pos-health" }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching" # missing data here means the probe itself stopped running - treat that as a failure, not silence
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "platform"
  }
}
