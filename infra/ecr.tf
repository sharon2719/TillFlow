# One ECR repository per service, created as each service is actually ready to ship an
# image. pos is first.
#
# Enhanced (Inspector-based) scanning is configured at the REGISTRY level in this AWS
# account (aws_ecr_registry_scanning_configuration), and this account is shared across the
# whole cohort (see docs/adr/0002-region.md) — the registry currently shows scanType=BASIC,
# account-wide. Managing that singleton from this group's Terraform risks fighting other
# groups' state or getting silently reverted by someone else's apply, so it's deliberately
# left alone here. Basic scan-on-push is enabled per-repository instead, which is scoped to
# just this repo and can't collide with anyone else's config. If the registry is later
# switched to ENHANCED account-wide (e.g. by a course admin), this repo picks it up for free
# with no change needed here.
resource "aws_ecr_repository" "pos" {
  name                 = "${var.name_prefix}/pos"
  image_tag_mutability = "IMMUTABLE" # no retagging — pairs with "no latest tags, deploy by digest"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    service = "pos"
  }
}

resource "aws_ecr_lifecycle_policy" "pos" {
  repository = aws_ecr_repository.pos.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "expire untagged images after 7 days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_repository" "payments" {
  name                 = "${var.name_prefix}/payments"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    service = "payments"
  }
}

resource "aws_ecr_lifecycle_policy" "payments" {
  repository = aws_ecr_repository.payments.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "expire untagged images after 7 days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_repository" "commission" {
  name                 = "${var.name_prefix}/commission"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    service = "commission"
  }
}

resource "aws_ecr_lifecycle_policy" "commission" {
  repository = aws_ecr_repository.commission.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "expire untagged images after 7 days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_repository" "web" {
  name                 = "${var.name_prefix}/web"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    service = "web"
  }
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "expire untagged images after 7 days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = { type = "expire" }
    }]
  })
}
