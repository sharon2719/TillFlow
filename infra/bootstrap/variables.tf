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

variable "owner" {
  description = "DRI tag value, see docs/ownership.md."
  type        = string
  default     = "sharon2719"
}

variable "environment" {
  description = "Environment tag."
  type        = string
  default     = "dev"
}
