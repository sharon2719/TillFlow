# Same pattern as infra/ecs-task-def.tf's pos_image_tag/pos_current — see that file's
# comments for the full rationale (a hardcoded "bootstrap" default here silently reverted a
# real running image on every apply without an explicit -var override, including CI's own
# terraform plan job).
variable "payments_image_tag" {
  description = "Explicit image tag override. Leave unset (default) and terraform reuses whatever tag is currently live instead of reverting it. Only pass -var to force a specific tag: a genuine first-ever bootstrap on a fresh account with no task definition yet, or a deliberate manual rollback."
  type        = string
  default     = null
}

data "aws_ecs_task_definition" "payments_current" {
  task_definition = "${var.name_prefix}-payments"
}

locals {
  payments_image = var.payments_image_tag != null ? "${aws_ecr_repository.payments.repository_url}:${var.payments_image_tag}" : [
    for c in jsondecode(data.aws_ecs_task_definition.payments_current.container_definitions) : c.image if c.name == "payments"
  ][0]
}

# --- Daraja credentials: real external credentials from Safaricom's own developer portal
# (Consumer Key/Secret, sandbox shortcode/passkey, B2C initiator/security credential) -
# unlike web's SESSION_SECRET or Grafana's admin password, Terraform can't generate these
# itself. Terraform manages the secret container + IAM only; the real JSON value is
# populated out-of-band via `aws secretsmanager put-secret-value`, never typed into a .tf
# file or Terraform state as a literal - lifecycle.ignore_changes keeps a later
# `terraform apply` from ever reverting it back to the "unset" placeholder below. See
# docs/production-readiness.md and services/payments/.env.daraja.example.
resource "aws_secretsmanager_secret" "daraja_credentials" {
  name = "${var.name_prefix}-daraja-credentials"

  tags = {
    service = "payments"
  }
}

resource "aws_secretsmanager_secret_version" "daraja_credentials" {
  secret_id = aws_secretsmanager_secret.daraja_credentials.id
  secret_string = jsonencode({
    DARAJA_CONSUMER_KEY        = "unset"
    DARAJA_CONSUMER_SECRET     = "unset"
    DARAJA_SHORTCODE           = "unset"
    DARAJA_PASSKEY             = "unset"
    DARAJA_INITIATOR_NAME      = "unset"
    DARAJA_SECURITY_CREDENTIAL = "unset"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_ecs_task_definition" "payments" {
  family                   = "${var.name_prefix}-payments"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.payments_exec.arn
  task_role_arn            = aws_iam_role.payments_task.arn

  container_definitions = jsonencode([
    {
      name                   = "payments"
      image                  = local.payments_image
      essential              = true
      readonlyRootFilesystem = true
      linuxParameters = {
        tmpfs = [
          { containerPath = "/tmp", size = 64 }
        ]
      }
      portMappings = [
        { containerPort = 3001, protocol = "tcp" }
      ]
      environment = [
        { name = "PORT", value = "3001" },
        { name = "DB_HOST", value = aws_db_instance.main.address },
        { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DB_NAME", value = aws_db_instance.main.db_name },
        { name = "DB_SCHEMA", value = "payments" },
        # Not a secret - the public API Gateway endpoint Daraja calls back to.
        { name = "DARAJA_CALLBACK_BASE_URL", value = aws_apigatewayv2_api.main.api_endpoint },
      ]
      secrets = [
        { name = "DB_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
        { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
        { name = "DARAJA_CONSUMER_KEY", valueFrom = "${aws_secretsmanager_secret.daraja_credentials.arn}:DARAJA_CONSUMER_KEY::" },
        { name = "DARAJA_CONSUMER_SECRET", valueFrom = "${aws_secretsmanager_secret.daraja_credentials.arn}:DARAJA_CONSUMER_SECRET::" },
        { name = "DARAJA_SHORTCODE", valueFrom = "${aws_secretsmanager_secret.daraja_credentials.arn}:DARAJA_SHORTCODE::" },
        { name = "DARAJA_PASSKEY", valueFrom = "${aws_secretsmanager_secret.daraja_credentials.arn}:DARAJA_PASSKEY::" },
        { name = "DARAJA_INITIATOR_NAME", valueFrom = "${aws_secretsmanager_secret.daraja_credentials.arn}:DARAJA_INITIATOR_NAME::" },
        { name = "DARAJA_SECURITY_CREDENTIAL", valueFrom = "${aws_secretsmanager_secret.daraja_credentials.arn}:DARAJA_SECURITY_CREDENTIAL::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.payments.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "payments"
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
          "awslogs-group"         = aws_cloudwatch_log_group.payments_adot.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "adot"
        }
      }
    }
  ])

  tags = {
    service = "payments"
  }
}

resource "aws_ecs_service" "payments" {
  name            = "${var.name_prefix}-payments"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.payments.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.payments_task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.payments.arn
    container_name   = "payments"
    container_port   = 3001
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener_rule.payments]

  tags = {
    service = "payments"
  }
}
