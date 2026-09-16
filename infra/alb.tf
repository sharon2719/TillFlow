# Internal ALB - only reachable from inside the VPC (the API Gateway VPC Link), never
# exposed to the public internet directly. Public entry is the API Gateway in
# api-gateway.tf.

resource "aws_lb" "main" {
  name                       = "${var.name_prefix}-alb"
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = aws_subnet.private[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true

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

# Plain HTTP, deliberately: this ALB is internal-only (see the file header) and unreachable
# except through the API Gateway VPC Link, which already terminates TLS for every public
# request at the API Gateway edge. Adding HTTPS here too would need an ACM certificate,
# which needs a domain this project doesn't have yet. Accepted risk, not an oversight - see
# docs/production-readiness.md for the real fix (a private CA / self-signed cert once a
# domain exists) and revisit before G5.
# trivy:ignore:AWS-0054 -- accepted risk, owner sharon2719, revisit before G5; see docs/production-readiness.md
resource "aws_lb_listener" "pos" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pos.arn
  }

  # A listener has no name of its own in AWS's model - Name here is only for the audit
  # script and console readability, not something AWS exposes as an editable property.
  tags = {
    Name    = "${var.name_prefix}-alb-http"
    service = "pos"
  }
}

# --- payments + commission share this same ALB, routed by path - one internal ALB, one
# listener, rules dispatching by path prefix, rather than a second ALB per service (real
# ongoing cost) or per-service Cloud Map/Service Connect (real added complexity) for what's
# still a small number of services. pos keeps the listener's default_action above -
# everything that doesn't match a more specific rule below still goes to pos, same as
# before these existed. ---

resource "aws_lb_target_group" "payments" {
  name        = "${var.name_prefix}-payments-tg"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    service = "payments"
  }
}

resource "aws_lb_listener_rule" "payments" {
  listener_arn = aws_lb_listener.pos.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.payments.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/payments/*"]
    }
  }

  tags = {
    service = "payments"
  }
}

resource "aws_lb_target_group" "commission" {
  name        = "${var.name_prefix}-commission-tg"
  port        = 3002
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    service = "commission"
  }
}

resource "aws_lb_listener_rule" "commission" {
  listener_arn = aws_lb_listener.pos.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.commission.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/commission/*"]
    }
  }

  tags = {
    service = "commission"
  }
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name_prefix}-web-tg"
  port        = 3003
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    service = "web"
  }
}

# web's UI/BFF routes all live under /app/* (login, dashboard, form actions) - a distinct
# prefix from the other services' /api/v1/<service>/* convention, chosen so a plain "/" and
# "/login" aren't ambiguous with pos's default_action catch-all.
resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.pos.arn
  priority     = 30

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    path_pattern {
      values = ["/app/*"]
    }
  }

  tags = {
    service = "web"
  }
}

resource "aws_lb_target_group" "grafana" {
  name        = "${var.name_prefix}-grafana-tg"
  port        = 3004
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    # Grafana runs with GF_SERVER_SERVE_FROM_SUB_PATH=true (infra/ecs-grafana.tf), so it
    # expects the /grafana prefix on every request, including this direct health check.
    path                = "/grafana/api/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    service = "grafana"
  }
}

resource "aws_lb_listener_rule" "grafana" {
  listener_arn = aws_lb_listener.pos.arn
  priority     = 40

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.grafana.arn
  }

  condition {
    path_pattern {
      values = ["/grafana/*"]
    }
  }

  tags = {
    service = "grafana"
  }
}
