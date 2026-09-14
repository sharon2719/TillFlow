# VPC with public subnets (ALB, NAT) and private subnets (ECS tasks, RDS, ElastiCache)
# across `var.az_count` Availability Zones, per the brief's platform baseline.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # /24s carved out of the /16: 10.20.0.0/24, 10.20.1.0/24 (public), 10.20.10.0/24, 10.20.11.0/24 (private), etc.
  public_subnet_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i + 10)]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "${var.name_prefix}-vpc"
    service = "network"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags = {
    Name    = "${var.name_prefix}-igw"
    service = "network"
  }
}

resource "aws_subnet" "public" {
  count             = var.az_count
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  # No auto-assigned public IPs here (Trivy AWS-0164). Nothing placed in this subnet needs
  # it: the NAT gateway uses the Elastic IP allocated explicitly below, and an ALB's public
  # IPs are managed by the load balancer itself, not this subnet setting. Leaving it on
  # would only make it easier for something dropped into this subnet later to end up with
  # an implicit public IP nobody decided on.
  map_public_ip_on_launch = false

  tags = {
    Name    = "${var.name_prefix}-public-${local.azs[count.index]}"
    service = "network"
    tier    = "public"
  }
}

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = {
    Name    = "${var.name_prefix}-private-${local.azs[count.index]}"
    service = "network"
    tier    = "private"
  }
}

# Single NAT gateway (not one per AZ) — a deliberate cost trade-off for a capstone, logged
# here rather than hidden: it means a NAT-side AZ outage takes private-subnet egress down
# with it. Noted as a production-hardening follow-up in docs/production-readiness.md.
resource "aws_eip" "nat" {
  domain = "vpc"
  tags = {
    Name    = "${var.name_prefix}-nat-eip"
    service = "network"
  }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]

  tags = {
    Name    = "${var.name_prefix}-nat"
    service = "network"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name    = "${var.name_prefix}-public-rt"
    service = "network"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = {
    Name    = "${var.name_prefix}-private-rt"
    service = "network"
  }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
