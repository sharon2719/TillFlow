# Same pattern as infra/ecs-task-def.tf's pos_image_tag/pos_current — see that file's
# comments for the full rationale (a hardcoded "bootstrap" default here silently reverted a
# real running image on every apply without an explicit -var override, including CI's own
# terraform plan job).
variable "commission_image_tag" {
  description = "Explicit image tag override. Leave unset (default) and terraform reuses whatever tag is currently live instead of reverting it. Only pass -var to force a specific tag: a genuine first-ever bootstrap on a fresh account with no task definition yet, or a deliberate manual rollback."
  type        = string
  default     = null
}

data "aws_ecs_task_definition" "commission_current" {
  task_definition = "${var.name_prefix}-commission"
}

locals {
  commission_image = var.commission_image_tag != null ? "${aws_ecr_repository.commission.repository_url}:${var.commission_image_tag}" : [
    for c in jsondecode(data.aws_ecs_task_definition.commission_current.container_definitions) : c.image if c.name == "commission"
  ][0]
}

resource "aws_ecs_task_definition" "commission" {
  family                   = "${var.name_prefix}-commission"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.commission_exec.arn
  task_role_arn            = aws_iam_role.commission_task.arn

  container_definitions = jsonencode([
    {
      name                   = "commission"
      image                  = local.commission_image
      essential              = true
      readonlyRootFilesystem = true
      linuxParameters = {
        tmpfs = [
          { containerPath = "/tmp", size = 64 }
        ]
      }
      portMappings = [
        { containerPort = 3002, protocol = "tcp" }
      ]
      environment = [
        { name = "PORT", value = "3002" },
        { name = "DB_HOST", value = aws_db_instance.main.address },
        { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DB_NAME", value = aws_db_instance.main.db_name },
        { name = "DB_SCHEMA", value = "commission" },
        # Calls payments through the SAME internal ALB (path-routed), not directly to the
        # payments task - see infra/security-groups.tf's commission_task_to_alb rule.
        { name = "PAYMENTS_API_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "AWS_REGION", value = var.region },
        # Starts the SQS worker loop (src/worker.ts) alongside the HTTP server - see
        # infra/async.tf and infra/iam.tf for the queue and its consumer IAM grant.
        { name = "COMMISSION_CLOSE_QUEUE_URL", value = aws_sqs_queue.commission_close.url },
      ]
      secrets = [
        { name = "DB_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
        { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.commission.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "commission"
        }
      }
      dependsOn = [
        { containerName = "aws-otel-collector", condition = "HEALTHY" }
      ]
    },
    {
      name                   = "aws-otel-collector"
      image                  = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.0"
      essential              = true
      command                = ["--config=/etc/ecs/ecs-default-config.yaml"]
      readonlyRootFilesystem = true
      linuxParameters = {
        tmpfs = [
          { containerPath = "/tmp", size = 64 }
        ]
      }
      healthCheck = {
        command     = ["CMD", "/healthcheck"]
        interval    = 10
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }
      environment = [
        { name = "AWS_REGION", value = var.region }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.commission_adot.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "adot"
        }
      }
    }
  ])

  tags = {
    service = "commission"
  }
}

resource "aws_ecs_service" "commission" {
  name            = "${var.name_prefix}-commission"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.commission.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.commission_task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.commission.arn
    container_name   = "commission"
    container_port   = 3002
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener_rule.commission]

  tags = {
    service = "commission"
  }
}
