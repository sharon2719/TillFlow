# Same pattern as infra/ecs-task-def.tf's pos_image_tag/pos_current — see that file's
# comments for the full rationale (a hardcoded "bootstrap" default here silently reverted a
# real running image on every apply without an explicit -var override, including CI's own
# terraform plan job).
variable "web_image_tag" {
  description = "Explicit image tag override. Leave unset (default) and terraform reuses whatever tag is currently live instead of reverting it. Only pass -var to force a specific tag: a genuine first-ever bootstrap on a fresh account with no task definition yet, or a deliberate manual rollback."
  type        = string
  default     = null
}

data "aws_ecs_task_definition" "web_current" {
  task_definition = "${var.name_prefix}-web"
}

locals {
  web_image = var.web_image_tag != null ? "${aws_ecr_repository.web.repository_url}:${var.web_image_tag}" : [
    for c in jsondecode(data.aws_ecs_task_definition.web_current.container_definitions) : c.image if c.name == "web"
  ][0]
}

# Signs the session cookie in services/web/src/session.ts - not a credential of its own,
# see the comment on aws_iam_role.web_exec in iam.tf for why this is a plain env var rather
# than a Secrets Manager secret.
resource "random_password" "web_session_secret" {
  length  = 48
  special = false
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name_prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.web_exec.arn
  task_role_arn            = aws_iam_role.web_task.arn

  container_definitions = jsonencode([
    {
      name                   = "web"
      image                  = local.web_image
      essential              = true
      readonlyRootFilesystem = true
      linuxParameters = {
        tmpfs = [
          { containerPath = "/tmp", size = 64 }
        ]
      }
      portMappings = [
        { containerPort = 3003, protocol = "tcp" }
      ]
      environment = [
        { name = "PORT", value = "3003" },
        # All three point at the same internal ALB, dispatched by the path-based listener
        # rules in infra/alb.tf - same pattern as commission's PAYMENTS_API_URL.
        { name = "POS_API_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "PAYMENTS_API_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "COMMISSION_API_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "SESSION_SECRET", value = random_password.web_session_secret.result },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "web"
        }
      }
      dependsOn = [
        { containerName = "aws-otel-collector", condition = "START" }
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
      environment = [
        { name = "AWS_REGION", value = var.region }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web_adot.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "adot"
        }
      }
    }
  ])

  tags = {
    service = "web"
  }
}

resource "aws_ecs_service" "web" {
  name            = "${var.name_prefix}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web_task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3003
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener_rule.web]

  tags = {
    service = "web"
  }
}
