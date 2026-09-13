locals {
  # Retain prior lifecycle logs at their existing addresses for investigation.
  retired_lambda_logs = {
    conversation-completion  = true
    conversation-coordinator = true
  }
  lambda_names = merge(
    local.retired_lambda_logs,
    {
      agents-api        = true
      agents-outbox     = true
      connection-health = true
      control           = true
      dispatcher        = true
      notifier          = true
      reconciler        = true
      state-stream      = true
      thing-schedule    = true
    },
    {
      webhook-github = local.github_enabled
      webhook-gitlab = local.gitlab_enabled
      webhook-teams  = local.teams_enabled
      webhook-slack  = local.slack_enabled
    },
  )
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = { for name, enabled in local.lambda_names : name => enabled if enabled }

  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/${local.name}/api"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "microvm" {
  name              = "/${local.name}/microvms"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}
