# Least-privilege chain: API Gateway's VPC Link ENIs -> ALB -> pos task, each hop only
# opening the port the next hop actually needs, nothing wider.
#
# Rules live as standalone aws_vpc_security_group_{ingress,egress}_rule resources rather
# than inline blocks on aws_security_group, specifically so vpc_link, alb and pos_task can
# each reference one another (alb's ingress needs vpc_link's ID; vpc_link's egress needs
# alb's ID) without a circular dependency - the bare security groups have no dependency on
# each other at all, only the separate rule resources do, and by the time those are
# created both groups already exist.
#
# Do NOT add `ingress = []` / `egress = []` to these bare security groups. That's only a
# one-time migration trick (used once, then removed) to force Terraform to revoke inline
# rules left over from an earlier version of this file - it works by making the SG resource
# treat "no rules" as its permanently-enforced desired state, which then fights the separate
# rule resources below forever (each apply alternately reverting the other). Confirmed this
# the hard way: leaving it in place made every subsequent plan want to delete the very rules
# the standalone resources had just created.

resource "aws_security_group" "vpc_link" {
  name_prefix = "${var.name_prefix}-vpclink-"
  description = "ENIs for the API Gateway VPC Link"
  vpc_id      = aws_vpc.main.id

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

  tags = {
    Name    = "${var.name_prefix}-pos-task-sg"
    service = "pos"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- vpc_link -> alb (port 80) ---

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_alb" {
  security_group_id            = aws_security_group.vpc_link.id
  description                  = "to the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_vpc_link" {
  security_group_id            = aws_security_group.alb.id
  description                  = "from the API Gateway VPC Link"
  referenced_security_group_id = aws_security_group.vpc_link.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
}

# --- alb -> pos_task (port 3000) ---

resource "aws_vpc_security_group_egress_rule" "alb_to_pos_task" {
  security_group_id            = aws_security_group.alb.id
  description                  = "to the pos ECS task"
  referenced_security_group_id = aws_security_group.pos_task.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "pos_task_from_alb" {
  security_group_id            = aws_security_group.pos_task.id
  description                  = "from the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

# --- pos_task egress ---
#
# DNS resolution stays inside the VPC (its default resolver lives at the VPC base+2
# address), so this is scoped to the VPC CIDR, not the internet - fully tightenable, no
# accepted-risk needed.
resource "aws_vpc_security_group_egress_rule" "pos_task_dns_tcp" {
  security_group_id = aws_security_group.pos_task.id
  description       = "DNS (VPC resolver only)"
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "pos_task_dns_udp" {
  security_group_id = aws_security_group.pos_task.id
  description       = "DNS (VPC resolver only)"
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

# ECR image pulls, CloudWatch Logs, X-Ray, and STS (for the exec role) are all reached as
# public AWS API endpoints over the NAT gateway - there are no VPC endpoints for them yet,
# so this genuinely needs internet-wide reach on 443. Documented as an accepted risk rather
# than silently left broad: see docs/production-readiness.md for the real fix (VPC
# interface endpoints for ecr.api/ecr.dkr/logs/xray/sts + a gateway endpoint for s3) and why
# it isn't done yet (added cost/complexity not justified for the current golden-path scope).
# trivy:ignore:AWS-0104 -- accepted risk, owner sharon2719, revisit before G5 or when VPC endpoints are added; see docs/production-readiness.md
resource "aws_vpc_security_group_egress_rule" "pos_task_https" {
  security_group_id = aws_security_group.pos_task.id
  description       = "HTTPS to AWS APIs (ECR/CloudWatch/X-Ray/STS) via NAT - no VPC endpoints yet, see docs/production-readiness.md"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}
