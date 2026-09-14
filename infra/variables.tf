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
