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
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,13}$", var.deployment_id))
    error_message = "deployment_id must be 3-14 lowercase letters, digits, or hyphens, starting with a letter or digit."
  }
}

variable "enable_microvm" {
  description = "Build and validate the AWS Lambda MicroVM backend."
  type        = bool
  default     = true
}

variable "microvm_base_image_version" {
  description = "Pinned managed al2023-1 image version. Required when enable_microvm is true."
  type        = string
  default     = "1"
}

variable "codex_model_id" {
  description = "Exact Bedrock Mantle model ID used by the optional real-Codex canary."
  type        = string
  default     = "openai.gpt-5.6-terra"
}

variable "integration_oauth_app_secret_arns" {
  description = "Optional operator-owned OAuth application secrets used by an explicit live provider canary."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for id, arn in var.integration_oauth_app_secret_arns :
      can(regex("^[a-z][a-z0-9-]{0,63}$", id)) && can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$", arn))
    ])
    error_message = "integration_oauth_app_secret_arns must map valid plugin IDs to Secrets Manager ARNs."
  }
}

variable "enable_slack_webhook" {
  description = "Provision the disposable Slack signing-secret container and signed Events API route."
  type        = bool
  default     = false
}

variable "enable_publication_delivery" {
  description = "Provision the disposable CloudFront publication delivery path."
  type        = bool
  default     = false
}

variable "publication_base_domain" {
  description = "Dedicated user-content base domain for the disposable publication distribution."
  type        = string
  default     = null
  nullable    = true
}

variable "publication_route53_zone_id" {
  description = "Public Route 53 zone that owns publication_base_domain."
  type        = string
  default     = null
  nullable    = true
}

variable "publication_public_key_pem" {
  description = "Ephemeral RSA public key used by the CloudFront trusted key group."
  type        = string
  default     = null
  nullable    = true
}

variable "enable_ec2_worker" {
  type        = bool
  default     = false
  description = "Run persistent Sessions on dedicated ARM64 EC2 workers."
}
variable "ec2_worker_ami_id" {
  type        = string
  default     = null
  description = "Pinned Amazon Linux 2023 ARM64 AMI ID."
}
variable "ec2_worker_image" {
  type        = string
  default     = null
  description = "Worker image in private ECR, pinned by digest."
}
variable "ec2_worker_instance_type" {
  type    = string
  default = "m7g.large"
}
variable "environment_relay_image" {
  description = "Pinned ARM64 image for the dedicated HTTPS API and executor relay."
  type        = string
  default     = null
}

variable "environment_relay_origin_hostname" {
  description = "Dedicated API/relay hostname pointing to the output ALB DNS name."
  type        = string
  default     = null
}

variable "environment_relay_origin_certificate_arn" {
  description = "Regional ACM certificate covering the dedicated API/relay hostname."
  type        = string
  default     = null
}
