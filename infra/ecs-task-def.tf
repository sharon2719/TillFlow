# The container image tag here is a bootstrap placeholder only. Once the CI pipeline does
# its first real deploy, it registers a new task definition revision pointing at the actual
# commit-SHA image and calls UpdateService directly (see aws_ecs_service's
# ignore_changes = [task_definition] in ecs-service.tf) — Terraform owns the task
# definition's *shape*, the pipeline owns which revision is actually running, so the two
# don't fight each other on every apply.
variable "pos_image_tag" {
  description = "Bootstrap-only image tag. The real running revision is owned by the deploy pipeline after the first deploy."
  type        = string
  default     = "bootstrap"
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
      image     = "${aws_ecr_repository.pos.repository_url}:${var.pos_image_tag}"
      essential = true
      portMappings = [
        { containerPort = 3000, protocol = "tcp" }
      ]
      environment = [
        { name = "PORT", value = "3000" }
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
