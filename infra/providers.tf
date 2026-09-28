provider "aws" {
  region  = var.region
  profile = var.aws_profile == "" ? null : var.aws_profile

  default_tags {
    tags = {
      group       = var.name_prefix
      owner       = var.owner
      environment = var.environment
      managed-by  = "terraform"
      capstone    = "tillflow"
      # `service` is set per-resource (or per-module) below, not here — it varies.
    }
  }
}
