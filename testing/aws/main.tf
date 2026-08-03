locals {
  name_prefix = "indubitably-agent"
  tags = {
    Ephemeral    = "true"
    DeploymentId = var.deployment_id
    Purpose      = "live-e2e-validation"
  }

  lambda_zip_paths = {
    control        = "${path.root}/../../dist/control.zip"
    dispatcher     = "${path.root}/../../dist/dispatcher.zip"
    notifier       = "${path.root}/../../dist/notifier.zip"
    reconciler     = "${path.root}/../../dist/reconciler.zip"
    state-stream   = "${path.root}/../../dist/state-stream.zip"
    webhook-github = "${path.root}/../../dist/webhook-github.zip"
    webhook-gitlab = "${path.root}/../../dist/webhook-gitlab.zip"
    webhook-teams  = "${path.root}/../../dist/webhook-teams.zip"
    webhook-slack  = "${path.root}/../../dist/webhook-slack.zip"
  }
}

resource "aws_secretsmanager_secret" "github_webhook" {
  name                    = "${local.name_prefix}-${var.deployment_id}/github-webhook"
  description             = "Disposable GitHub webhook signing secret for ${var.deployment_id}"
  recovery_window_in_days = 0
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "gitlab_webhook" {
  name                    = "${local.name_prefix}-${var.deployment_id}/gitlab-webhook"
  description             = "Disposable GitLab webhook signing secret for ${var.deployment_id}"
  recovery_window_in_days = 0
  tags                    = local.tags
}

module "agent_runner" {
  source = "../../infra/modules/agent-runner"

  name_prefix                      = local.name_prefix
  environment                      = var.deployment_id
  vpc_cidr                         = "10.254.0.0/16"
  enable_nat_gateway               = var.enable_microvm
  enable_vpc_endpoints             = false
  artifact_retention_days          = 1
  log_retention_days               = 1
  force_destroy_data               = true
  enable_point_in_time_recovery    = false
  run_retention_seconds            = 3600
  allowed_repository_hosts         = ["github.com", "gitlab.com"]
  allowed_sandbox_modes            = ["read-only", "workspace-write"]
  default_execution_backend        = "ecs"
  default_agent_driver             = "mock"
  allow_agent_aws_credential_chain = false
  default_delivery_destinations    = "none"
  worker_image_tag                 = var.worker_image_tag
  ecs_assign_public_ip             = true
  worker_cpu                       = 256
  worker_memory                    = 512
  worker_ephemeral_storage_gib     = 21
  lambda_zip_paths                 = local.lambda_zip_paths
  github_webhook_secret_arn        = aws_secretsmanager_secret.github_webhook.arn
  github_webhook_enabled           = true
  gitlab_webhook_secret_arn        = aws_secretsmanager_secret.gitlab_webhook.arn
  gitlab_webhook_enabled           = true
  enable_microvm                   = var.enable_microvm
  microvm_source_zip_path          = "${path.root}/../../dist/microvm-source.zip"
  microvm_base_image_version       = var.microvm_base_image_version
  tags                             = local.tags
}

resource "aws_sqs_queue" "terminal_events" {
  name                       = "${local.name_prefix}-${var.deployment_id}-terminal-events"
  message_retention_seconds  = 3600
  receive_wait_time_seconds  = 10
  visibility_timeout_seconds = 30
  sqs_managed_sse_enabled    = true
  tags                       = local.tags
}

resource "aws_cloudwatch_event_rule" "terminal_events" {
  name           = "${local.name_prefix}-${var.deployment_id}-terminal-capture"
  description    = "Disposable capture target used by the live AWS end-to-end test"
  event_bus_name = module.agent_runner.event_bus_name
  event_pattern = jsonencode({
    source      = ["indubitably.agent-runtime"]
    detail-type = ["Agent Run State"]
    detail = {
      status = ["succeeded", "failed", "cancelled"]
    }
  })
  tags = local.tags
}

data "aws_iam_policy_document" "terminal_events" {
  statement {
    sid       = "AllowEphemeralTerminalEventCapture"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.terminal_events.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.terminal_events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "terminal_events" {
  queue_url = aws_sqs_queue.terminal_events.url
  policy    = data.aws_iam_policy_document.terminal_events.json
}

resource "aws_cloudwatch_event_target" "terminal_events" {
  rule           = aws_cloudwatch_event_rule.terminal_events.name
  event_bus_name = module.agent_runner.event_bus_name
  target_id      = "live-e2e-capture"
  arn            = aws_sqs_queue.terminal_events.arn

  depends_on = [aws_sqs_queue_policy.terminal_events]
}
