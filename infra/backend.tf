# Provisioned by infra/bootstrap on 2026-09-15 (see that stack's outputs / this repo's
# evidence for the apply). Real values, not placeholders.

terraform {
  backend "s3" {
    bucket         = "devops-g5-tfstate-240462142849"
    key            = "tillflow/main.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "devops-g5-tflock"
    encrypt        = true
  }
}
