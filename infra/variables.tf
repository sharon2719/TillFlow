variable "aws_profile" {
  description = "AWS CLI profile for local runs (SSO). CI uses OIDC and leaves this empty."
  type        = string
  default     = "devops-g5"
}

variable "name_prefix" {
  description = "Resource name prefix. devops-g5 per the cohort's SSO role (group 5) — see docs/adr/0004-object-storage.md."
  type        = string
  default     = "devops-g5"
}

variable "region" {
  description = "AWS region. Cohort-assigned (group 5 = eu-west-1) — see docs/adr/0002-region.md."
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "Environment tag, e.g. dev, staging, prod. This capstone only stands up one."
  type        = string
  default     = "dev"
}

variable "owner" {
  description = "DRI tag value, see docs/ownership.md."
  type        = string
  default     = "sharon2719"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "Number of Availability Zones to spread subnets across. The brief requires at least two."
  type        = number
  default     = 2
  validation {
    condition     = var.az_count >= 2
    error_message = "At least two AZs are required for the private-subnet ECS + Multi-AZ layout."
  }
}
