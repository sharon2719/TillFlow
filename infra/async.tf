# G1 platform scaffolding the brief calls for alongside VPC/ECS/RDS: a cache, a queue+DLQ,
# and a scheduled trigger. None has an application-code consumer wired up yet - that's
# tracked explicitly below and in docs/production-readiness.md, not silently implied to be
# finished. Provisioning these now (rather than only "once a service actually needs them",
# this repo's usual rule) is deliberate: the brief's G1 checklist asks for them by name as
# platform deliverables, ahead of and independent from which G2 feature ends up using them.

# --- ElastiCache (Redis): no consumer yet. Security group has zero ingress rules on
# purpose - the same "add the rule when a real caller exists" pattern as every other
# security group in this repo (see infra/security-groups.tf's header), not an oversight. ---

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.name_prefix}-cache"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    service = "platform"
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.name_prefix}-redis-"
  description = "ElastiCache Redis - no ingress yet, no consumer wired up (see infra/async.tf header)"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${var.name_prefix}-redis-sg"
    service = "platform"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.name_prefix}-cache"
  description          = "TillFlow shared cache - single node, no consumer wired up yet"

  engine             = "redis"
  engine_version     = "7.1"
  node_type          = "cache.t4g.micro"
  num_cache_clusters = 1
  port               = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  tags = {
    service = "platform"
  }
}

# --- SQS + DLQ: for commission's scheduled run below. The queue exists and the schedule
# below feeds it; nothing consumes it yet (services/commission still runs as an
# HTTP-invoked API, not a queue worker) - see docs/production-readiness.md for that gap. ---

resource "aws_sqs_queue" "commission_close_dlq" {
  name                      = "${var.name_prefix}-commission-close-dlq"
  message_retention_seconds = 1209600 # 14 days - max, so a failed run isn't lost before anyone looks

  tags = {
    service = "commission"
  }
}

resource "aws_sqs_queue" "commission_close" {
  name                       = "${var.name_prefix}-commission-close"
  message_retention_seconds  = 345600 # 4 days
  visibility_timeout_seconds = 60

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.commission_close_dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    service = "commission"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "commission_close_dlq" {
  queue_url = aws_sqs_queue.commission_close_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.commission_close.arn]
  })
}

# --- EventBridge Scheduler: fires daily at 05:00 EAT (Africa/Nairobi), 1.5h ahead of the
# 06:30 EAT SLO target in docs/slo-error-budgets.md, and drops a message on the queue above.
# Nothing reads that message yet - this schedule proves the trigger exists and fires
# correctly (visible in CloudWatch/the queue's message count), which is the G1 platform
# deliverable; wiring an actual consumer that calls commission's close logic is G2 work. ---

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "commission_close_scheduler" {
  name               = "${var.name_prefix}-commission-close-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json

  tags = {
    service = "commission"
  }
}

data "aws_iam_policy_document" "commission_close_scheduler_sqs" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.commission_close.arn]
  }
}

resource "aws_iam_role_policy" "commission_close_scheduler_sqs" {
  name   = "${var.name_prefix}-commission-close-scheduler-sqs"
  role   = aws_iam_role.commission_close_scheduler.id
  policy = data.aws_iam_policy_document.commission_close_scheduler_sqs.json
}

resource "aws_scheduler_schedule" "commission_close_daily" {
  name       = "${var.name_prefix}-commission-close-daily"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(0 5 * * ? *)"
  schedule_expression_timezone = "Africa/Nairobi"

  target {
    arn      = aws_sqs_queue.commission_close.arn
    role_arn = aws_iam_role.commission_close_scheduler.arn
    input    = jsonencode({ action = "daily-commission-close", triggeredBy = "eventbridge-scheduler" })
  }
}
