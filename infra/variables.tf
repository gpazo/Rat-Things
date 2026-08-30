variable "aws_region" {
  description = "AWS Region for the deployment."
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "Optional shared-credentials profile. Leave null for the normal AWS credential chain."
  type        = string
  default     = null
  nullable    = true
}

variable "name_prefix" {
  type    = string
  default = "rat-things"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "artifact_retention_days" {
  type    = number
  default = 30
}

variable "artifact_url_ttl_seconds" {
  description = "Lifetime of publication grants, from one minute to one day."
  type        = number
  default     = 86400

  validation {
    condition = (
      floor(var.artifact_url_ttl_seconds) == var.artifact_url_ttl_seconds &&
      var.artifact_url_ttl_seconds >= 60 &&
      var.artifact_url_ttl_seconds <= 86400
    )
    error_message = "artifact_url_ttl_seconds must be a whole number from 60 through 86400."
  }
}

variable "enable_publication_delivery" {
  description = "Enable isolated CloudFront delivery for immutable file, site, and video publications."
  type        = bool
  default     = false
}

variable "publication_base_domain" {
  type     = string
  default  = null
  nullable = true
}

variable "publication_certificate_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "publication_public_key_pem" {
  type     = string
  default  = null
  nullable = true
}

variable "publication_private_key_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "publication_private_key_kms_key_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "publication_route53_zone_id" {
  type     = string
  default  = null
  nullable = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "force_destroy_data" {
  type    = bool
  default = false
}

variable "enable_point_in_time_recovery" {
  type    = bool
  default = true
}

variable "enable_detailed_api_metrics" {
  description = "Opt in to per-route API Gateway metrics; low-cardinality queue and processing metrics remain enabled."
  type        = bool
  default     = false
}

variable "run_retention_seconds" {
  type    = number
  default = 2592000
}

variable "allowed_repository_hosts" {
  type    = list(string)
  default = ["github.com", "gitlab.com"]

  validation {
    condition = length(var.allowed_repository_hosts) > 0 && alltrue([
      for host in var.allowed_repository_hosts : can(regex("^[A-Za-z0-9.-]+$", host))
    ])
    error_message = "allowed_repository_hosts must be non-empty and contain only DNS hostnames without schemes or paths."
  }
}

variable "allowed_sandbox_modes" {
  type    = list(string)
  default = ["read-only", "workspace-write", "danger-full-access"]
}

variable "default_sandbox_mode" {
  type    = string
  default = "danger-full-access"
}

variable "default_agent_network_access" {
  type    = bool
  default = true
}

variable "default_agent_driver" {
  description = "Defaults to mock so a new deployment cannot accidentally spend model tokens."
  type        = string
  default     = "mock"
}

variable "allow_agent_aws_credential_chain" {
  description = "Explicit opt-in for passing a scoped AWS credential chain to Codex. Short-term bearer tokens are preferred."
  type        = bool
  default     = false
}

variable "default_delivery_destinations" {
  type    = string
  default = "source"
}

variable "lambda_zip_paths" {
  description = "Override packaged Lambda paths when the root is consumed from a different repository layout."
  type        = map(string)
  default     = {}
}

variable "integration_oauth_app_secret_arns" {
  description = "Secrets Manager ARNs for deployment-owned OAuth applications, keyed by plugin ID."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for id, arn in var.integration_oauth_app_secret_arns :
      can(regex("^[a-z][a-z0-9-]{0,63}$", id)) && can(regex("^arn:[A-Za-z0-9-]+:secretsmanager:[A-Za-z0-9-]+:[0-9]{12}:secret:[^[:space:]]+$", arn))
    ])
    error_message = "integration_oauth_app_secret_arns must map valid plugin IDs to Secrets Manager ARNs."
  }
}

variable "enable_connection_health_monitor" {
  type    = bool
  default = true
}

variable "connection_health_schedule_expression" {
  type    = string
  default = "rate(15 minutes)"
}

variable "connection_health_stale_minutes" {
  type    = number
  default = 60
}

variable "connection_health_check_limit" {
  type    = number
  default = 10
}

variable "connection_health_check_concurrency" {
  type    = number
  default = 3
}

variable "github_webhook_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "github_webhook_enabled" {
  type     = bool
  default  = null
  nullable = true
}

variable "github_clone_token_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "github_notify_token_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "github_api_base_url" {
  description = "GitHub REST API base URL; set the enterprise /api/v3 endpoint for GitHub Enterprise Server."
  type        = string
  default     = "https://api.github.com"

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$", var.github_api_base_url))
    error_message = "github_api_base_url must be an HTTPS origin with an optional port and path, without credentials, query, or fragment."
  }
}

variable "github_comment_trigger" {
  type    = string
  default = "@rat-things"

  validation {
    condition     = trimspace(var.github_comment_trigger) != ""
    error_message = "github_comment_trigger cannot be empty or whitespace."
  }
}

variable "gitlab_webhook_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "gitlab_webhook_enabled" {
  type     = bool
  default  = null
  nullable = true
}

variable "gitlab_clone_token_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "gitlab_notify_token_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "gitlab_api_base_url" {
  description = "GitLab REST API base URL, normally ending in /api/v4."
  type        = string
  default     = "https://gitlab.com/api/v4"

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$", var.gitlab_api_base_url))
    error_message = "gitlab_api_base_url must be an HTTPS origin with an optional port and path, without credentials, query, or fragment."
  }
}

variable "gitlab_comment_trigger" {
  type    = string
  default = "@rat-things"

  validation {
    condition     = trimspace(var.gitlab_comment_trigger) != ""
    error_message = "gitlab_comment_trigger cannot be empty or whitespace."
  }
}

variable "teams_outgoing_webhook_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "teams_webhook_enabled" {
  type     = bool
  default  = null
  nullable = true
}

variable "teams_workflow_url_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "teams_delivery_mode" {
  type    = string
  default = "workflow"

  validation {
    condition     = contains(["workflow", "threaded-gateway"], var.teams_delivery_mode)
    error_message = "teams_delivery_mode must be workflow or threaded-gateway."
  }
}

variable "teams_reply_gateway_url_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "teams_route_secret_arns" {
  type    = map(string)
  default = {}
}

variable "slack_signing_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "slack_webhook_enabled" {
  type     = bool
  default  = null
  nullable = true
}

variable "slack_bot_token_secret_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "worker_secret_arns" {
  type    = list(string)
  default = []
}

variable "codex_bedrock_model_ids" {
  description = "Exact Bedrock Mantle model IDs that Codex may invoke."
  type        = list(string)
  default     = ["openai.gpt-5.6-terra"]
}

variable "bedrock_api_key_secret_arn" {
  description = "Optional Secrets Manager ARN holding a Bedrock API key; plaintext is never a Terraform input."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "enable_microvm" {
  description = "Provision the Lambda MicroVM execution backend. Must remain enabled."
  type        = bool
  default     = true
}

variable "enable_s3_files" {
  description = "Mount durable per-conversation Codex and workspace state through S3 Files. Creates dedicated VPC/NAT networking."
  type        = bool
  default     = false
}

variable "s3_files_vpc_cidr" {
  description = "IPv4 CIDR for the dedicated S3 Files mount-target and MicroVM connector VPC."
  type        = string
  default     = "10.242.0.0/24"

  validation {
    condition     = can(cidrhost(var.s3_files_vpc_cidr, 1)) && tonumber(split("/", var.s3_files_vpc_cidr)[1]) <= 24
    error_message = "s3_files_vpc_cidr must be a valid IPv4 CIDR with at least 256 addresses."
  }
}

variable "microvm_source_zip_path" {
  type     = string
  default  = null
  nullable = true
}

variable "microvm_base_image_arn" {
  type     = string
  default  = null
  nullable = true
}

variable "microvm_base_image_version" {
  description = "Pinned AVAILABLE al2023-1 managed base-image version; required when enable_microvm is true."
  type        = string
  default     = null
  nullable    = true
}

variable "microvm_memory_mib" {
  type    = number
  default = 4096
}

variable "tags" {
  type    = map(string)
  default = {}
}
