# G1 platform scaffolding the brief calls for alongside VPC/ECS/RDS: a cache, a queue+DLQ,
# and a scheduled trigger. G4 (docs/recovery-drills.md) wired the first real consumers for
# both: pos's requireAuth (services/pos/src/cache.ts) reads/writes the Redis replication
# group below as a read-through cache in front of the api_keys DB lookup, and commission's
# SQS worker (services/commission/src/worker.ts) consumes the queue below - see that file's
# own header for why it's still a deliberately narrow consumer, not full cross-tenant
# reconciliation.

# --- ElastiCache (Redis): consumed by pos's auth cache. Ingress is scoped to exactly the
# one real caller, same pattern as every other security group in this repo (see
# infra/security-groups.tf's header). ---

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.name_prefix}-cache"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    service = "platform"
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.name_prefix}-redis-"
  description = "ElastiCache Redis - ingress only from the pos ECS task"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${var.name_prefix}-redis-sg"
    service = "platform"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_pos_task" {
  security_group_id            = aws_security_group.redis.id
  description                  = "from the pos ECS task"
  referenced_security_group_id = aws_security_group.pos_task.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"

  tags = {
    service = "pos"
  }
}

resource "aws_vpc_security_group_egress_rule" "pos_task_to_redis" {
  security_group_id            = aws_security_group.pos_task.id
  description                  = "to ElastiCache Redis"
  referenced_security_group_id = aws_security_group.redis.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"

  tags = {
    service = "pos"
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.name_prefix}-cache"
  description          = "TillFlow shared cache - pos's API-key auth read-through cache"

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

# --- SQS + DLQ: for commission's scheduled run below. commission's own process now long-
# polls this queue (services/commission/src/worker.ts, started from index.ts when
# COMMISSION_CLOSE_QUEUE_URL is set - see infra/ecs-commission.tf and infra/iam.tf for the
# env var and the IAM grant). ---

resource "aws_sqs_queue" "commission_close_dlq" {
  name                      = "${var.name_prefix}-commission-close-dlq"
  message_retention_seconds = 1209600 # 14 days - max, so a failed run isn't lost before anyone looks
  # SSE-SQS (Amazon-owned key): fully managed, zero extra IAM/key-policy grants needed for
  # any producer/consumer - unlike a customer-managed KMS key (see monitoring.tf's SNS
  # topic for that tradeoff), there's no key policy to get subtly wrong here.
  sqs_managed_sse_enabled = true

  tags = {
    service = "commission"
  }
}

resource "aws_sqs_queue" "commission_close" {
  name                       = "${var.name_prefix}-commission-close"
  message_retention_seconds  = 345600 # 4 days
  visibility_timeout_seconds = 60
  sqs_managed_sse_enabled    = true

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
# commission's worker now reads and records every message this produces (see the SQS
# section above) - it deliberately doesn't yet perform the full cross-tenant sales
# reconciliation a real "close everyone's day" run would need (see
# migrations/002_scheduled_runs.sql for why that's separate, not-yet-built work). ---

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
