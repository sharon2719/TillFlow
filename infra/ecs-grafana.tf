# Same bootstrap-placeholder pattern as ecs-task-def.tf's pos_image_tag.
variable "grafana_image_tag" {
  description = "Bootstrap-only image tag. The real running revision is owned by the deploy pipeline after the first deploy."
  type        = string
  default     = "bootstrap"
}

# A real credential (unlike web's SESSION_SECRET, which only signs a cookie) - this one
# guards the Grafana admin login, so it goes through Secrets Manager rather than a plain
# task-def env var. random_password avoids ever hand-typing or committing it.
resource "random_password" "grafana_admin_password" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "grafana_admin_password" {
  name = "${var.name_prefix}-grafana-admin-password"

  tags = {
    service = "grafana"
  }
}

resource "aws_secretsmanager_secret_version" "grafana_admin_password" {
  secret_id     = aws_secretsmanager_secret.grafana_admin_password.id
  secret_string = random_password.grafana_admin_password.result
}

resource "aws_ecs_task_definition" "grafana" {
  family                   = "${var.name_prefix}-grafana"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.grafana_exec.arn
  task_role_arn            = aws_iam_role.grafana_task.arn

  container_definitions = jsonencode([
    {
      name                   = "grafana"
      image                  = "${aws_ecr_repository.grafana.repository_url}:${var.grafana_image_tag}"
      essential              = true
      readonlyRootFilesystem = true
      linuxParameters = {
        # Grafana's own default data/log/plugin paths aren't writable under a read-only
        # root filesystem, so they're redirected onto this tmpfs mount via GF_PATHS_* below
        # instead of relaxing readonlyRootFilesystem for this one container.
        tmpfs = [
          { containerPath = "/tmp", size = 256 }
        ]
      }
      portMappings = [
        { containerPort = 3004, protocol = "tcp" }
      ]
      environment = [
        { name = "GF_SERVER_HTTP_PORT", value = "3004" },
        { name = "GF_SERVER_ROOT_URL", value = "http://${aws_lb.main.dns_name}/grafana/" },
        { name = "GF_SERVER_SERVE_FROM_SUB_PATH", value = "true" },
        { name = "GF_PATHS_DATA", value = "/tmp/data" },
        { name = "GF_PATHS_LOGS", value = "/tmp/logs" },
        { name = "GF_PATHS_PLUGINS", value = "/tmp/plugins" },
        { name = "GF_ANALYTICS_REPORTING_ENABLED", value = "false" },
        { name = "GF_ANALYTICS_CHECK_FOR_UPDATES", value = "false" },
      ]
      secrets = [
        { name = "GF_SECURITY_ADMIN_PASSWORD", valueFrom = aws_secretsmanager_secret.grafana_admin_password.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.grafana.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "grafana"
        }
      }
    }
  ])

  tags = {
    service = "grafana"
  }
}

resource "aws_ecs_service" "grafana" {
  name            = "${var.name_prefix}-grafana"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.grafana.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.grafana_task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.grafana.arn
    container_name   = "grafana"
    container_port   = 3004
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener_rule.grafana]

  tags = {
    service = "grafana"
  }
}
