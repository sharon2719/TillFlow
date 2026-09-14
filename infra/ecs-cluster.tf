resource "aws_ecs_cluster" "main" {
  name = var.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name    = var.name_prefix
    service = "platform"
  }
}
