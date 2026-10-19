variable "name" {
  description = "Prefix for the edge resources."
  type        = string
  default     = "signin-reports"
}

variable "vpc_id" {
  description = "VPC the ALB and its target groups live in."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets, one per AZ, for the internet-facing ALB."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "An ALB needs subnets in at least two availability zones."
  }
}

variable "certificate_arn" {
  description = "ACM certificate for the dashboard host, in the current partition."
  type        = string
}

variable "access_logs_bucket" {
  description = "S3 bucket (owned by infra/monitoring) that receives the ALB access logs."
  type        = string
}

variable "api_security_group_id" {
  description = "Security group of the api ECS service (infra/platform)."
  type        = string
}

variable "keycloak_security_group_id" {
  description = "Security group of the Keycloak ECS service (infra/platform)."
  type        = string
}

variable "api_port" {
  description = "HTTPS port the api container serves on."
  type        = number
  default     = 8443
}

variable "keycloak_port" {
  description = "HTTPS port Keycloak serves the signin-reports realm on."
  type        = number
  default     = 8443
}

variable "keycloak_management_port" {
  description = "Keycloak management interface port; carries /health/ready and is never routed."
  type        = number
  default     = 9000
}

variable "tags" {
  description = "Tags applied to every edge resource."
  type        = map(string)
  default     = {}
}
