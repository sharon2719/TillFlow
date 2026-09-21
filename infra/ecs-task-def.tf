# Once the CI pipeline does its first real deploy, it registers a new task definition
# revision pointing at the actual commit-SHA image and calls UpdateService directly (see
# aws_ecs_service's ignore_changes = [task_definition] in ecs-service.tf) — Terraform owns
# the task definition's *shape*, the pipeline owns which revision is actually running, so the
# two don't fight each other on every apply.
#
# The tag itself defaults to whatever's actually live (see data.aws_ecs_task_definition.pos_current
# below), not a hardcoded placeholder — a bare "bootstrap" default here silently reverted a real
# running image back to a tag that was never pushed to ECR on every apply that didn't pass an
# explicit -var override, including CI's own terraform plan job. See
# docs/production-readiness.md.
variable "pos_image_tag" {
  description = "Explicit image tag override. Leave unset (default) and terraform reuses whatever tag is currently live instead of reverting it. Only pass -var to force a specific tag: a genuine first-ever bootstrap on a fresh account with no task definition yet, or a deliberate manual rollback."
  type        = string
  default     = null
}

# Reads the currently ACTIVE revision so a plain apply/plan never proposes reverting a real
# deployed image. Only works once the family has at least one real revision — true for every
# service in this already-deployed account; a genuine from-scratch bootstrap on a brand-new
# account still needs pos_image_tag passed explicitly the first time, since this lookup would
# have nothing to find.
data "aws_ecs_task_definition" "pos_current" {
  task_definition = "${var.name_prefix}-pos"
}

locals {
  pos_image = var.pos_image_tag != null ? "${aws_ecr_repository.pos.repository_url}:${var.pos_image_tag}" : [
    for c in jsondecode(data.aws_ecs_task_definition.pos_current.container_definitions) : c.image if c.name == "pos"
  ][0]
}

resource "aws_ecs_task_definition" "pos" {
  family                   = "${var.name_prefix}-pos"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.pos_exec.arn
  task_role_arn            = aws_iam_role.pos_task.arn

  container_definitions = jsonencode([
    {
      name      = "pos"
      image     = local.pos_image
      essential = true
      # Non-root already at the Dockerfile level (see services/pos/Dockerfile); this closes
      # out the "read-only" half of the golden path's container pattern. /tmp is the only
      # writable path Node itself might reach for, given via tmpfs rather than a real
      # writable layer.
      readonlyRootFilesystem = true
      linuxParameters = {
        tmpfs = [
          { containerPath = "/tmp", size = 64 }
        ]
      }
      portMappings = [
        { containerPort = 3000, protocol = "tcp" }
      ]
      environment = [
        { name = "PORT", value = "3000" },
        { name = "DB_HOST", value = aws_db_instance.main.address },
        { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DB_NAME", value = aws_db_instance.main.db_name },
        { name = "DB_SCHEMA", value = "pos" },
        # services/pos/src/cache.ts's read-through auth cache. rediss:// (not redis://) is
        # required here - the replication group has transit_encryption_enabled = true
        # (infra/async.tf), so ioredis must negotiate TLS or the connection is refused
        # outright, not just unencrypted.
        { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:${aws_elasticache_replication_group.main.port}" },
      ]
      # Pulled by the execution role (infra/iam.tf: pos_exec_db_secret) from the
      # AWS-managed RDS credential, injected as plain env vars before the app starts - the
      # app never calls Secrets Manager itself. Per-service least-privilege DB roles (the
      # fuller ADR-0003 vision) aren't built yet; this uses the master credential with
      # schema-level separation only - logged as a gap in docs/production-readiness.md.
      secrets = [
        { name = "DB_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
        { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.pos.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "pos"
        }
      }
      dependsOn = [
        { containerName = "aws-otel-collector", condition = "START" }
      ]
    },
    {
      # Every backend task = app + ADOT sidecar, per the brief's platform baseline.
      # ecs-default-config.yaml ships inside this image: an OTLP receiver (4317/4318) that
      # exports metrics via awsemf to CloudWatch and traces via awsxray to X-Ray. pos
      # doesn't emit real OTLP telemetry yet (its own OTel SDK wiring is a separate,
      # not-yet-done piece — see docs/architecture.md status) so this proves the sidecar
      # boots and is reachable, not that traces are flowing end to end yet.
      name      = "aws-otel-collector"
      image     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.0"
      essential = true
      command   = ["--config=/etc/ecs/ecs-default-config.yaml"]
      # Read-only here too - the collector doesn't need to persist anything, and if it
      # ever needs scratch space (buffering, etc.) it has tmpfs /tmp same as pos.
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
          "awslogs-group"         = aws_cloudwatch_log_group.pos_adot.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "adot"
        }
      }
    }
  ])

  tags = {
    service = "pos"
  }
}
