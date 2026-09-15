# Single RDS PostgreSQL instance, shared across services via one schema + one
# least-privilege role per service (docs/adr/0003-database.md) - pos is the first tenant of
# that pattern; payments/commission get their own schema+role added here when they're built,
# same incremental approach as everything else in this repo.

resource "aws_db_subnet_group" "main" {
  name       = "${var.name_prefix}-db"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name    = "${var.name_prefix}-db-subnet-group"
    service = "platform"
  }
}

resource "aws_security_group" "rds" {
  name_prefix = "${var.name_prefix}-rds-"
  description = "RDS PostgreSQL - ingress only from the pos ECS task"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${var.name_prefix}-rds-sg"
    service = "platform"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_pos_task" {
  security_group_id            = aws_security_group.rds.id
  description                  = "from the pos ECS task"
  referenced_security_group_id = aws_security_group.pos_task.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"

  tags = {
    service = "pos"
  }
}

resource "aws_vpc_security_group_egress_rule" "pos_task_to_rds" {
  security_group_id            = aws_security_group.pos_task.id
  description                  = "to RDS"
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"

  tags = {
    service = "pos"
  }
}

resource "aws_db_instance" "main" {
  identifier = "${var.name_prefix}-db"
  engine     = "postgres"
  # Confirmed available via `aws rds describe-db-engine-versions` before use - 16.4 isn't
  # offered in this account/region as of this writing, only 16.9 and up.
  engine_version = "16.15"

  instance_class    = "db.t4g.micro"
  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true # AWS-managed key (aws/rds) - avoids wiring a second CMK for this pass

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  db_name  = "tillflow"
  username = "tillflow_admin"
  # AWS creates and rotates the master password in Secrets Manager itself - no password
  # ever passes through Terraform state or this repo.
  manage_master_user_password = true

  # Single-AZ (docs/adr/0003 - disclosed cost trade-off, not an oversight) and no RDS Proxy
  # yet (docs/production-readiness.md - the app connects directly via pg.Pool client-side
  # pooling for now; ADR-0003 calls for RDS Proxy, not yet built).
  multi_az = false

  backup_window           = "23:00-00:00" # UTC == 02:00-03:00 EAT, outside the 06:30 EAT commission window
  backup_retention_period = 7

  # Capstone-scope trade-offs, both logged in docs/production-readiness.md:
  deletion_protection = false
  skip_final_snapshot = true

  tags = {
    Name    = "${var.name_prefix}-db"
    service = "platform"
  }
}
