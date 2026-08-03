variable "aws_region" {
  description = "AWS Region used for the disposable validation stack."
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "Optional AWS shared-credentials profile."
  type        = string
  default     = null
  nullable    = true
}

variable "deployment_id" {
  description = "Short unique identifier included in every resource name and tag."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,19}$", var.deployment_id))
    error_message = "deployment_id must be 3-20 lowercase letters, digits, or hyphens, starting with a letter or digit."
  }
}

variable "worker_image_tag" {
  description = "Immutable tag pushed by the deploy script before the full apply."
  type        = string
}

variable "enable_microvm" {
  description = "Build and validate the AWS Lambda MicroVM backend in addition to ECS."
  type        = bool
  default     = false
}

variable "microvm_base_image_version" {
  description = "Pinned managed al2023-1 image version. Required when enable_microvm is true."
  type        = string
  default     = null
  nullable    = true
}
