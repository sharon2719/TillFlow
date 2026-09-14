# Internal ALB - only reachable from inside the VPC (the API Gateway VPC Link), never
# exposed to the public internet directly. Public entry is the API Gateway in
# api-gateway.tf.

resource "aws_lb" "main" {
  name               = "${var.name_prefix}-alb"
  internal           = true
  load_balancer_type = "application"
  subnets            = aws_subnet.private[*].id
  security_groups    = [aws_security_group.alb.id]

  tags = {
    Name    = "${var.name_prefix}-alb"
    service = "network"
  }
}

resource "aws_lb_target_group" "pos" {
  name        = "${var.name_prefix}-pos-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # Fargate awsvpc mode registers ENIs, not instances

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    service = "pos"
  }
}

resource "aws_lb_listener" "pos" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pos.arn
  }
}
