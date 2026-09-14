resource "aws_ecs_service" "pos" {
  name            = "${var.name_prefix}-pos"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.pos.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.pos_task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.pos.arn
    container_name   = "pos"
    container_port   = 3000
  }

  # G4's "broken release" drill needs this: a failed deployment (bad health checks) rolls
  # back to the previous task definition automatically instead of getting stuck half-deployed.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    # The deploy pipeline registers new task definition revisions and updates the service
    # directly (see ecs-task-def.tf) - Terraform shouldn't revert that on the next apply.
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener.pos]

  tags = {
    service = "pos"
  }
}
