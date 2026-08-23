data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  name = "${var.name_prefix}-${var.environment}"
  tags = merge(var.tags, {
    Environment = var.environment
    ManagedBy   = "Terraform"
    Project     = var.name_prefix
    Subsystem   = "agent-runner"
  })

  bucket_suffix             = substr(sha256("${data.aws_caller_identity.current.account_id}:${data.aws_region.current.region}:${local.name}"), 0, 12)
  thing_schedule_target_arn = "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${local.name}-thing-schedule"

  lambda_zip_paths = merge({
    control                  = "${path.root}/../dist/control.zip"
    conversation-completion  = "${path.root}/../dist/conversation-completion.zip"
    conversation-coordinator = "${path.root}/../dist/conversation-coordinator.zip"
    dispatcher               = "${path.root}/../dist/dispatcher.zip"
    notifier                 = "${path.root}/../dist/notifier.zip"
    reconciler               = "${path.root}/../dist/reconciler.zip"
    state-stream             = "${path.root}/../dist/state-stream.zip"
    thing-schedule           = "${path.root}/../dist/thing-schedule.zip"
    webhook-github           = "${path.root}/../dist/webhook-github.zip"
    webhook-gitlab           = "${path.root}/../dist/webhook-gitlab.zip"
    webhook-teams            = "${path.root}/../dist/webhook-teams.zip"
    webhook-slack            = "${path.root}/../dist/webhook-slack.zip"
  }, var.lambda_zip_paths)

  microvm_source_zip_path = coalesce(
    var.microvm_source_zip_path,
    "${path.root}/../dist/microvm-source.zip",
  )

  github_enabled = var.github_webhook_enabled != null ? var.github_webhook_enabled : var.github_webhook_secret_arn != null
  gitlab_enabled = var.gitlab_webhook_enabled != null ? var.gitlab_webhook_enabled : var.gitlab_webhook_secret_arn != null
  teams_enabled  = var.teams_webhook_enabled != null ? var.teams_webhook_enabled : var.teams_outgoing_webhook_secret_arn != null
  slack_enabled  = var.slack_webhook_enabled != null ? var.slack_webhook_enabled : var.slack_signing_secret_arn != null
  # The input is marked sensitive to prevent accidental CLI display. Only the
  # Secrets Manager ARN (never its value) is intentionally declassified here.
  bedrock_api_key_secret_arn = nonsensitive(var.bedrock_api_key_secret_arn)

  github_clone_token_secret_arn  = var.github_clone_token_secret_arn != null ? var.github_clone_token_secret_arn : var.github_token_secret_arn
  github_notify_token_secret_arn = var.github_notify_token_secret_arn != null ? var.github_notify_token_secret_arn : var.github_token_secret_arn
  gitlab_clone_token_secret_arn  = var.gitlab_clone_token_secret_arn != null ? var.gitlab_clone_token_secret_arn : var.gitlab_token_secret_arn
  gitlab_notify_token_secret_arn = var.gitlab_notify_token_secret_arn != null ? var.gitlab_notify_token_secret_arn : var.gitlab_token_secret_arn

  ingress_secret_arns = compact([
    var.github_webhook_secret_arn,
    var.gitlab_webhook_secret_arn,
    var.teams_outgoing_webhook_secret_arn,
    var.slack_signing_secret_arn,
  ])
  notifier_secret_arns = distinct(compact(concat([
    local.github_notify_token_secret_arn,
    local.gitlab_notify_token_secret_arn,
    var.teams_reply_gateway_url_secret_arn,
    var.teams_workflow_url_secret_arn,
    var.slack_bot_token_secret_arn,
  ], values(var.teams_route_secret_arns))))
  worker_secret_arns = distinct(concat(
    var.worker_secret_arns,
    compact([
      local.github_clone_token_secret_arn,
      local.gitlab_clone_token_secret_arn,
      local.bedrock_api_key_secret_arn,
    ]),
  ))

  supported_microvm_regions = toset([
    "ap-northeast-1",
    "eu-west-1",
    "us-east-1",
    "us-east-2",
    "us-west-2",
  ])
  microvm_base_image_arn = coalesce(
    var.microvm_base_image_arn,
    "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:aws:microvm-image:al2023-1",
  )
  microvm_build_egress_connector_arn = "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"

  microvm_tags = [for key, value in local.tags : {
    key   = key
    value = value
  }]
}

check "microvm_region" {
  assert {
    condition     = !var.enable_microvm || contains(local.supported_microvm_regions, data.aws_region.current.region)
    error_message = "Lambda MicroVMs are not available in this Region. Use us-east-1, us-east-2, us-west-2, ap-northeast-1, or eu-west-1."
  }
}

check "microvm_base_image_version" {
  assert {
    condition     = !var.enable_microvm ? true : (var.microvm_base_image_version == null ? false : trimspace(var.microvm_base_image_version) != "")
    error_message = "microvm_base_image_version must pin an AVAILABLE managed image version when enable_microvm is true."
  }
}

check "microvm_enabled" {
  assert {
    condition     = var.enable_microvm
    error_message = "enable_microvm must remain true because Lambda MicroVM is the only execution backend."
  }
}

check "s3_files_requires_microvm" {
  assert {
    condition     = !var.enable_s3_files || var.enable_microvm
    error_message = "enable_s3_files requires enable_microvm because the file system is mounted by the MicroVM runner."
  }
}

check "microvm_session_idle_window" {
  assert {
    condition     = var.microvm_session_idle_seconds > var.conversation_slice_timeout_seconds
    error_message = "microvm_session_idle_seconds must exceed conversation_slice_timeout_seconds so an active slice is not auto-suspended."
  }
}

check "enabled_webhook_secrets" {
  assert {
    condition = (
      (!local.github_enabled || var.github_webhook_secret_arn != null) &&
      (!local.gitlab_enabled || var.gitlab_webhook_secret_arn != null) &&
      (!local.teams_enabled || var.teams_outgoing_webhook_secret_arn != null) &&
      (!local.slack_enabled || var.slack_signing_secret_arn != null)
    )
    error_message = "Every explicitly enabled webhook must have its corresponding signing-secret ARN."
  }
}

check "teams_threaded_gateway" {
  assert {
    condition = (
      var.teams_delivery_mode != "threaded-gateway" ||
      var.teams_reply_gateway_url_secret_arn != null
    )
    error_message = "teams_reply_gateway_url_secret_arn is required when teams_delivery_mode is threaded-gateway."
  }
}
