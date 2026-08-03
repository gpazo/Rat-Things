variable "name_prefix" {
  description = "Lowercase prefix applied to named resources."
  type        = string
  default     = "indubitably-agent-runtime"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must be 3-31 lowercase alphanumeric or hyphen characters and start with a letter."
  }
}

variable "environment" {
  description = "Deployment environment label."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must contain at most 16 lowercase alphanumeric or hyphen characters."
  }
}

variable "artifact_retention_days" {
  description = "Days before run artifacts expire."
  type        = number
  default     = 30

  validation {
    condition     = var.artifact_retention_days >= 1
    error_message = "artifact_retention_days must be at least 1."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention in days."
  type        = number
  default     = 30
}

variable "force_destroy_data" {
  description = "Allow Terraform to delete non-empty S3 buckets. Keep false outside disposable environments."
  type        = bool
  default     = false
}

variable "enable_point_in_time_recovery" {
  description = "Enable DynamoDB point-in-time recovery for the runs table."
  type        = bool
  default     = true
}

variable "run_retention_seconds" {
  description = "TTL assigned to new run records."
  type        = number
  default     = 2592000

  validation {
    condition     = var.run_retention_seconds >= 3600
    error_message = "run_retention_seconds must be at least one hour."
  }
}

variable "allowed_repository_hosts" {
  description = "HTTPS repository hosts accepted by the control plane and workers."
  type        = list(string)
  default     = ["github.com", "gitlab.com"]

  validation {
    condition = length(var.allowed_repository_hosts) > 0 && alltrue([
      for host in var.allowed_repository_hosts : can(regex("^[A-Za-z0-9.-]+$", host))
    ])
    error_message = "allowed_repository_hosts must be non-empty and contain only DNS hostnames without schemes or paths."
  }
}

variable "allowed_sandbox_modes" {
  description = "Agent sandbox modes accepted by submission and worker validation. Add danger-full-access only after reviewing the outer isolation boundary."
  type        = list(string)
  default     = ["read-only", "workspace-write"]

  validation {
    condition = length(var.allowed_sandbox_modes) > 0 && alltrue([
      for mode in var.allowed_sandbox_modes : contains(["read-only", "workspace-write", "danger-full-access"], mode)
    ])
    error_message = "allowed_sandbox_modes must be a non-empty subset of read-only, workspace-write, and danger-full-access."
  }
}

variable "default_agent_driver" {
  description = "Default agent CLI used by a worker."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "codex"], var.default_agent_driver)
    error_message = "default_agent_driver must be mock or codex."
  }
}

variable "allow_agent_aws_credential_chain" {
  description = "Allow the Codex subprocess to inherit a scoped AWS credential chain. Disabled by default; short-term bearer tokens are preferred."
  type        = bool
  default     = false
}

variable "lambda_zip_paths" {
  description = "Optional overrides for packaged Lambda ZIPs, keyed by control, dispatcher, notifier, reconciler, state-stream, webhook-github, webhook-gitlab, webhook-teams, or webhook-slack."
  type        = map(string)
  default     = {}
}

variable "github_webhook_secret_arn" {
  description = "Secrets Manager ARN containing the GitHub webhook secret. Supplying it enables the GitHub route."
  type        = string
  default     = null
  nullable    = true
}

variable "github_webhook_enabled" {
  description = "Explicitly enable or disable the GitHub route. Leave null to infer enablement from github_webhook_secret_arn."
  type        = bool
  default     = null
  nullable    = true
}

variable "github_token_secret_arn" {
  description = "Deprecated compatibility ARN used for both GitHub clone and notification when the split variables are null."
  type        = string
  default     = null
  nullable    = true
}

variable "github_clone_token_secret_arn" {
  description = "Secrets Manager ARN containing the least-privilege GitHub token used only by repository workers."
  type        = string
  default     = null
  nullable    = true
}

variable "github_notify_token_secret_arn" {
  description = "Secrets Manager ARN containing the least-privilege GitHub token used only to post results."
  type        = string
  default     = null
  nullable    = true
}

variable "github_api_base_url" {
  description = "GitHub REST API base URL used for result delivery, including a path prefix for GitHub Enterprise Server when required."
  type        = string
  default     = "https://api.github.com"

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$", var.github_api_base_url))
    error_message = "github_api_base_url must be an HTTPS origin with an optional port and path, without credentials, query, or fragment."
  }
}

variable "github_comment_trigger" {
  description = "Mention required before GitHub issue/PR comments create runs."
  type        = string
  default     = "@indubitably"

  validation {
    condition     = trimspace(var.github_comment_trigger) != ""
    error_message = "github_comment_trigger cannot be empty or whitespace."
  }
}

variable "gitlab_webhook_secret_arn" {
  description = "Secrets Manager ARN containing the GitLab webhook token. Supplying it enables the GitLab route."
  type        = string
  default     = null
  nullable    = true
}

variable "gitlab_webhook_enabled" {
  description = "Explicitly enable or disable the GitLab route. Leave null to infer enablement from gitlab_webhook_secret_arn."
  type        = bool
  default     = null
  nullable    = true
}

variable "gitlab_token_secret_arn" {
  description = "Deprecated compatibility ARN used for both GitLab clone and notification when the split variables are null."
  type        = string
  default     = null
  nullable    = true
}

variable "gitlab_clone_token_secret_arn" {
  description = "Secrets Manager ARN containing the least-privilege GitLab token used only by repository workers."
  type        = string
  default     = null
  nullable    = true
}

variable "gitlab_notify_token_secret_arn" {
  description = "Secrets Manager ARN containing the least-privilege GitLab token used only to post results."
  type        = string
  default     = null
  nullable    = true
}

variable "gitlab_api_base_url" {
  description = "GitLab REST API base URL used for result delivery, including the /api/v4 path."
  type        = string
  default     = "https://gitlab.com/api/v4"

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$", var.gitlab_api_base_url))
    error_message = "gitlab_api_base_url must be an HTTPS origin with an optional port and path, without credentials, query, or fragment."
  }
}

variable "gitlab_comment_trigger" {
  description = "Mention required before GitLab note comments create runs."
  type        = string
  default     = "@indubitably"

  validation {
    condition     = trimspace(var.gitlab_comment_trigger) != ""
    error_message = "gitlab_comment_trigger cannot be empty or whitespace."
  }
}

variable "teams_outgoing_webhook_secret_arn" {
  description = "Secrets Manager ARN containing the Teams outgoing-webhook HMAC secret. Supplying it enables the Teams route."
  type        = string
  default     = null
  nullable    = true
}

variable "teams_webhook_enabled" {
  description = "Explicitly enable or disable the Teams route. Leave null to infer enablement from teams_outgoing_webhook_secret_arn."
  type        = bool
  default     = null
  nullable    = true
}

variable "teams_workflow_url_secret_arn" {
  description = "Secrets Manager ARN containing the Teams Workflow callback URL used by the notifier."
  type        = string
  default     = null
  nullable    = true
}

variable "teams_route_secret_arns" {
  description = "Named Teams notification routes mapped to Secrets Manager ARNs containing Workflow callback URLs."
  type        = map(string)
  default     = {}
}

variable "slack_signing_secret_arn" {
  description = "Secrets Manager ARN containing the Slack signing secret. Supplying it enables the optional Slack route."
  type        = string
  default     = null
  nullable    = true
}

variable "slack_webhook_enabled" {
  description = "Explicitly enable or disable the Slack route. Leave null to infer enablement from slack_signing_secret_arn."
  type        = bool
  default     = null
  nullable    = true
}

variable "slack_bot_token_secret_arn" {
  description = "Secrets Manager ARN containing the optional Slack bot token used by the notifier."
  type        = string
  default     = null
  nullable    = true
}

variable "worker_secret_arns" {
  description = "Additional repository or agent credential secret ARNs that an isolated worker may read."
  type        = list(string)
  default     = []
}

variable "codex_bedrock_model_ids" {
  description = "Exact Bedrock Mantle model IDs that isolated Codex workers may invoke. Empty disables Codex inference permissions."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for model in var.codex_bedrock_model_ids : can(regex("^openai\\.gpt-[A-Za-z0-9.-]+$", model))
    ])
    error_message = "codex_bedrock_model_ids must contain exact OpenAI model IDs such as openai.gpt-5.6-terra."
  }
}

variable "bedrock_api_key_secret_arn" {
  description = "Optional Secrets Manager ARN holding a Bedrock API key. Only the ARN is injected; the root worker resolves the value before spawning the unprivileged agent."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "default_delivery_destinations" {
  description = "Comma-separated notifier destinations. Teams-first deployments normally use source,teams."
  type        = string
  default     = "source"
}

variable "enable_microvm" {
  description = "Provision the Lambda MicroVM execution backend. Must remain enabled."
  type        = bool
  default     = true
}

variable "microvm_source_zip_path" {
  description = "Optional path to the packaged MicroVM source ZIP. Defaults to dist/microvm-source.zip adjacent to infra."
  type        = string
  default     = null
  nullable    = true
}

variable "microvm_base_image_arn" {
  description = "Managed MicroVM base-image ARN. Null derives the regional al2023-1 ARN."
  type        = string
  default     = null
  nullable    = true
}

variable "microvm_base_image_version" {
  description = "Pinned AVAILABLE managed base-image version. Required when enable_microvm is true."
  type        = string
  default     = null
  nullable    = true
}

variable "microvm_memory_mib" {
  description = "Minimum memory for the Lambda MicroVM image."
  type        = number
  default     = 4096

  validation {
    condition     = contains([512, 1024, 2048, 4096, 8192], var.microvm_memory_mib)
    error_message = "microvm_memory_mib must be 512, 1024, 2048, 4096, or 8192."
  }
}

variable "tags" {
  description = "Additional tags applied to taggable resources."
  type        = map(string)
  default     = {}
}
