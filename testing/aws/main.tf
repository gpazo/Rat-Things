locals {
  name_prefix = "rat-things"
  tags = {
    Ephemeral    = "true"
    DeploymentId = var.deployment_id
    Purpose      = "live-e2e-validation"
  }

  lambda_zip_paths = {
    connection-health        = "${path.root}/../../dist/connection-health.zip"
    control                  = "${path.root}/../../dist/control.zip"
    conversation-completion  = "${path.root}/../../dist/conversation-completion.zip"
    conversation-coordinator = "${path.root}/../../dist/conversation-coordinator.zip"
    dispatcher               = "${path.root}/../../dist/dispatcher.zip"
    notifier                 = "${path.root}/../../dist/notifier.zip"
    reconciler               = "${path.root}/../../dist/reconciler.zip"
    state-stream             = "${path.root}/../../dist/state-stream.zip"
    thing-schedule           = "${path.root}/../../dist/thing-schedule.zip"
    webhook-github           = "${path.root}/../../dist/webhook-github.zip"
    webhook-gitlab           = "${path.root}/../../dist/webhook-gitlab.zip"
    webhook-teams            = "${path.root}/../../dist/webhook-teams.zip"
    webhook-slack            = "${path.root}/../../dist/webhook-slack.zip"
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

resource "aws_secretsmanager_secret" "teams_webhook" {
  name                    = "${local.name_prefix}-${var.deployment_id}/teams-webhook"
  description             = "Disposable Teams outgoing-webhook HMAC secret for ${var.deployment_id}"
  recovery_window_in_days = 0
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "slack_webhook" {
  count = var.enable_slack_webhook ? 1 : 0

  name                    = "${local.name_prefix}-${var.deployment_id}/slack-webhook"
  description             = "Disposable Slack Events API signing secret for ${var.deployment_id}"
  recovery_window_in_days = 0
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "teams_workflow" {
  name                    = "${local.name_prefix}-${var.deployment_id}/teams-workflow"
  description             = "Disposable Teams delivery-capture URL for ${var.deployment_id}"
  recovery_window_in_days = 0
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "publication_signing_key" {
  count = var.enable_publication_delivery ? 1 : 0

  name                    = "${local.name_prefix}-${var.deployment_id}/publication-signing-key"
  description             = "Disposable CloudFront publication signing key for ${var.deployment_id}"
  recovery_window_in_days = 0
  tags                    = local.tags
}

resource "aws_acm_certificate" "publication" {
  count    = var.enable_publication_delivery ? 1 : 0
  provider = aws.us_east_1

  domain_name       = "*.${var.publication_base_domain}"
  validation_method = "DNS"
  tags              = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "publication_certificate_validation" {
  for_each = var.enable_publication_delivery ? {
    for option in aws_acm_certificate.publication[0].domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  zone_id = var.publication_route53_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "publication" {
  count    = var.enable_publication_delivery ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.publication[0].arn
  validation_record_fqdns = [for record in aws_route53_record.publication_certificate_validation : record.fqdn]
}

module "agent_runner" {
  source = "../../infra/modules/agent-runner"

  name_prefix                 = local.name_prefix
  environment                 = var.deployment_id
  artifact_retention_days     = 1
  enable_publication_delivery = var.enable_publication_delivery
  publication_base_domain     = var.publication_base_domain
  publication_certificate_arn = try(aws_acm_certificate_validation.publication[0].certificate_arn, null)
  publication_public_key_pem  = var.publication_public_key_pem
  publication_private_key_secret_arn = try(
    aws_secretsmanager_secret.publication_signing_key[0].arn,
    null,
  )
  publication_route53_zone_id       = var.publication_route53_zone_id
  log_retention_days                = 1
  force_destroy_data                = true
  enable_point_in_time_recovery     = false
  run_retention_seconds             = 3600
  run_heartbeat_interval_seconds    = 30
  run_heartbeat_stale_seconds       = 60
  allowed_repository_hosts          = ["github.com", "gitlab.com"]
  allowed_sandbox_modes             = ["read-only", "workspace-write", "danger-full-access"]
  default_agent_driver              = var.default_agent_driver
  allow_agent_aws_credential_chain  = false
  codex_bedrock_model_ids           = [var.codex_model_id]
  default_delivery_destinations     = "source"
  integration_plugin_base_urls      = { fixture-crm = aws_lambda_function_url.integration_fixture.function_url }
  integration_oauth_app_secret_arns = var.integration_oauth_app_secret_arns
  lambda_zip_paths                  = local.lambda_zip_paths
  github_webhook_secret_arn         = aws_secretsmanager_secret.github_webhook.arn
  github_webhook_enabled            = true
  gitlab_webhook_secret_arn         = aws_secretsmanager_secret.gitlab_webhook.arn
  gitlab_webhook_enabled            = true
  teams_outgoing_webhook_secret_arn = aws_secretsmanager_secret.teams_webhook.arn
  teams_webhook_enabled             = true
  teams_workflow_url_secret_arn     = aws_secretsmanager_secret.teams_workflow.arn
  slack_signing_secret_arn          = try(aws_secretsmanager_secret.slack_webhook[0].arn, null)
  slack_webhook_enabled             = var.enable_slack_webhook
  enable_microvm                    = var.enable_microvm
  enable_s3_files                   = var.enable_microvm
  microvm_source_zip_path           = "${path.root}/../../dist/microvm-source.zip"
  microvm_base_image_version        = var.microvm_base_image_version
  tags                              = local.tags
}

resource "aws_sqs_queue" "integration_fixture_audit" {
  name                       = "${local.name_prefix}-${var.deployment_id}-integration-audit"
  message_retention_seconds  = 3600
  receive_wait_time_seconds  = 10
  visibility_timeout_seconds = 30
  sqs_managed_sse_enabled    = true
  tags                       = local.tags
}

data "aws_iam_policy_document" "integration_fixture_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "integration_fixture" {
  name               = "${local.name_prefix}-${var.deployment_id}-integration-fixture"
  assume_role_policy = data.aws_iam_policy_document.integration_fixture_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "integration_fixture" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.integration_fixture_audit.arn]
  }

  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.integration_fixture.arn}:*"]
  }
}

resource "aws_iam_role_policy" "integration_fixture" {
  name   = "fixture-runtime"
  role   = aws_iam_role.integration_fixture.id
  policy = data.aws_iam_policy_document.integration_fixture.json
}

resource "aws_cloudwatch_log_group" "integration_fixture" {
  name              = "/aws/lambda/${local.name_prefix}-${var.deployment_id}-integration-fixture"
  retention_in_days = 1
  tags              = local.tags
}

resource "aws_lambda_function" "integration_fixture" {
  function_name    = "${local.name_prefix}-${var.deployment_id}-integration-fixture"
  description      = "Disposable integration provider for live end-to-end validation"
  role             = aws_iam_role.integration_fixture.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  filename         = "${path.root}/../../dist/integration-fixture.zip"
  source_code_hash = fileexists("${path.root}/../../dist/integration-fixture.zip") ? filebase64sha256("${path.root}/../../dist/integration-fixture.zip") : null
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      AUDIT_QUEUE_URL = aws_sqs_queue.integration_fixture_audit.url
      DEPLOYMENT_ID   = var.deployment_id
    }
  }

  tags = merge(local.tags, { Component = "integration-fixture" })

  lifecycle {
    precondition {
      condition     = fileexists("${path.root}/../../dist/integration-fixture.zip")
      error_message = "The integration fixture Lambda package is missing. Run npm run package first."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.integration_fixture,
    aws_iam_role_policy.integration_fixture,
  ]
}

resource "aws_lambda_function_url" "integration_fixture" {
  function_name      = aws_lambda_function.integration_fixture.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "integration_fixture_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.integration_fixture.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "integration_fixture_invoke" {
  statement_id             = "AllowPublicFunctionUrlInvoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.integration_fixture.function_name
  principal                = "*"
  invoked_via_function_url = true
}

resource "aws_sqs_queue" "terminal_events" {
  name                       = "${local.name_prefix}-${var.deployment_id}-terminal-events"
  message_retention_seconds  = 3600
  receive_wait_time_seconds  = 10
  visibility_timeout_seconds = 30
  sqs_managed_sse_enabled    = true
  tags                       = local.tags
}

resource "aws_sqs_queue" "delivery_capture" {
  name                       = "${local.name_prefix}-${var.deployment_id}-delivery-capture"
  message_retention_seconds  = 3600
  receive_wait_time_seconds  = 10
  visibility_timeout_seconds = 30
  sqs_managed_sse_enabled    = true
  tags                       = local.tags
}

resource "aws_apigatewayv2_api" "delivery_capture" {
  name          = "${local.name_prefix}-${var.deployment_id}-delivery-capture"
  protocol_type = "HTTP"
  tags          = local.tags
}

data "aws_iam_policy_document" "delivery_capture_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "delivery_capture" {
  name               = "${local.name_prefix}-${var.deployment_id}-delivery-capture"
  assume_role_policy = data.aws_iam_policy_document.delivery_capture_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "delivery_capture" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.delivery_capture.arn]
  }
}

resource "aws_iam_role_policy" "delivery_capture" {
  name   = "send-to-delivery-capture"
  role   = aws_iam_role.delivery_capture.id
  policy = data.aws_iam_policy_document.delivery_capture.json
}

resource "aws_apigatewayv2_integration" "delivery_capture" {
  api_id                 = aws_apigatewayv2_api.delivery_capture.id
  integration_type       = "AWS_PROXY"
  integration_subtype    = "SQS-SendMessage"
  credentials_arn        = aws_iam_role.delivery_capture.arn
  payload_format_version = "1.0"
  request_parameters = {
    QueueUrl    = aws_sqs_queue.delivery_capture.url
    MessageBody = "$request.body"
  }
}

resource "aws_apigatewayv2_route" "delivery_capture" {
  api_id    = aws_apigatewayv2_api.delivery_capture.id
  route_key = "POST /teams"
  target    = "integrations/${aws_apigatewayv2_integration.delivery_capture.id}"
}

resource "aws_apigatewayv2_stage" "delivery_capture" {
  api_id      = aws_apigatewayv2_api.delivery_capture.id
  name        = "$default"
  auto_deploy = true
  tags        = local.tags
}

resource "aws_cloudwatch_event_rule" "terminal_events" {
  name           = "${local.name_prefix}-${var.deployment_id}-terminal-capture"
  description    = "Disposable capture target used by the live AWS end-to-end test"
  event_bus_name = module.agent_runner.event_bus_name
  event_pattern = jsonencode({
    source      = ["rat-things.agent-runtime"]
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
