terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # web's SESSION_SECRET (infra/ecs-web.tf) - the only thing needing this provider so far.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
