variable "name_prefix" {
  description = "Resource name prefix, e.g. devops-g<N>. Placeholder 'devops-g0' until the real group/account number is assigned — see docs/adr/0004-object-storage.md."
  type        = string
  default     = "devops-g0"
}

variable "region" {
  description = "AWS region. See docs/adr/0002-region.md."
  type        = string
  default     = "af-south-1"
}
