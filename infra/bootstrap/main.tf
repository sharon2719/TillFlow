# Bootstrap stack: creates the Terraform remote-state bucket + lock table that the main
# infra/ stack's own backend.tf then points at. Chicken-and-egg problem: something has to
# hold this stack's *own* state, so it's the one root module allowed to use local state.
#
# Apply this once, by hand, before touching infra/:
#   cd infra/bootstrap
#   terraform init
#   terraform apply
#
# Then copy the bucket/table names into infra/backend.tf.

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Deliberately local state for this one stack only.
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      managed-by = "terraform"
      capstone   = "tillflow"
      group      = var.name_prefix
      stack      = "bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  # Bucket names must be globally unique across all of AWS.
  account_suffix = data.aws_caller_identity.current.account_id
  tfstate_bucket = "${var.name_prefix}-tfstate-${local.account_suffix}"
  tflock_table   = "${var.name_prefix}-tflock"
}

resource "aws_kms_key" "tfstate" {
  description             = "${var.name_prefix} Terraform state encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_s3_bucket" "tfstate" {
  bucket = local.tfstate_bucket
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.tfstate.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_dynamodb_table" "tflock" {
  name         = local.tflock_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
