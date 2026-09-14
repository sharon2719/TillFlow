# Least-privilege chain: API Gateway's VPC Link ENIs -> ALB -> pos task, each hop only
# opening the port the next hop actually needs, nothing wider.

resource "aws_security_group" "vpc_link" {
  name_prefix = "${var.name_prefix}-vpclink-"
  description = "ENIs for the API Gateway VPC Link"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "to the ALB"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.name_prefix}-vpclink-sg"
    service = "network"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  description = "Internal ALB - ingress only from the API Gateway VPC Link"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "VPC Link -> ALB"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.vpc_link.id]
  }

  egress {
    description = "to ECS tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.name_prefix}-alb-sg"
    service = "network"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "pos_task" {
  name_prefix = "${var.name_prefix}-pos-task-"
  description = "pos ECS task - ingress only from the ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "ALB -> pos"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "outbound (ECR pull, CloudWatch/X-Ray export via NAT)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.name_prefix}-pos-task-sg"
    service = "pos"
  }

  lifecycle {
    create_before_destroy = true
  }
}
