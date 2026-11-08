resource "aws_apigatewayv2_api" "this" {
  name          = "${local.name}-api"
  description   = "Webhook ingress and IAM-authenticated agent-run control API"
  protocol_type = "HTTP"

  tags = local.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
      sourceIp         = "$context.identity.sourceIp"
    })
  }

  default_route_settings {
    detailed_metrics_enabled = var.enable_detailed_api_metrics
    throttling_burst_limit   = 50
    throttling_rate_limit    = 25
  }

  tags = local.tags
}

locals {
  api_integrations = merge(
    { control = aws_lambda_function.this["control"] },
    local.github_enabled ? { github = aws_lambda_function.this["webhook-github"] } : {},
    local.gitlab_enabled ? { gitlab = aws_lambda_function.this["webhook-gitlab"] } : {},
    local.teams_enabled ? { teams = aws_lambda_function.this["webhook-teams"] } : {},
    local.slack_enabled ? { slack = aws_lambda_function.this["webhook-slack"] } : {},
  )

  control_routes = toset([
    "POST /v1/rat/spaces",
    "POST /v1/sessions/{sessionId}/publications",
    "GET /v1/webhooks",
    "POST /v1/webhooks",
    "GET /v1/webhooks/{endpointId}",
    "POST /v1/webhooks/{endpointId}",
    "DELETE /v1/webhooks/{endpointId}",
    "POST /v1/webhooks/{endpointId}/rotate-secret",
    "GET /.well-known/rat-things",
    "GET /__share/{token}",
    "GET /health",
    "GET /openapi.json",
    "GET /schemas/agents-api.schema.json",
    "GET /v1/schedules",
    "POST /v1/schedules",
    "GET /v1/schedules/{scheduleId}",
    "PUT /v1/schedules/{scheduleId}",
    "DELETE /v1/schedules/{scheduleId}",
    "POST /v1/schedules/{scheduleId}/pause",
    "POST /v1/schedules/{scheduleId}/resume",
    "GET /v1/capability-profiles",
    "GET /v1/integrations/plugins",
    "GET /v1/integrations/oauth/callback",
    "GET /v1/integrations/connections",
    "GET /v1/integrations/connections/{connectionId}",
    "GET /v1/integrations/connections/{connectionId}/consumers",
    "GET /v1/integrations/connection-sets",
    "GET /v1/integrations/source-bindings",
    "POST /v1/integrations/connections",
    "POST /v1/integrations/oauth/authorizations",
    "POST /v1/integrations/connections/{connectionId}/credential",
    "POST /v1/integrations/connections/{connectionId}/oauth/reconnect",
    "POST /v1/integrations/connections/{connectionId}/grant",
    "POST /v1/integrations/connections/{connectionId}/revoke",
    "POST /v1/integrations/connections/{connectionId}/test",
    "POST /v1/integrations/connection-sets",
    "POST /v1/integrations/source-bindings",
    "PUT /v1/integrations/source-bindings/{bindingId}/event-policy",
    "POST /v1/integrations/thread-subscriptions/{id}/release",
    "GET /v1/integrations/thread-subscriptions",
    "GET /v1/integrations/thread-subscriptions/{id}",
    "PATCH /v1/integrations/connections/{connectionId}",
  ])

  webhook_routes = merge(
    local.github_enabled ? { "POST /webhooks/github" = "github" } : {},
    local.gitlab_enabled ? { "POST /webhooks/gitlab" = "gitlab" } : {},
    local.teams_enabled ? { "POST /webhooks/teams" = "teams" } : {},
    local.slack_enabled ? { "POST /webhooks/slack" = "slack" } : {},
  )
}

resource "aws_apigatewayv2_integration" "lambda" {
  for_each = local.api_integrations

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = each.value.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_integration" "agents_token_issuer" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.this["agents-token-issuer"].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "control" {
  for_each = local.control_routes

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value
  authorization_type = contains([
    "GET /.well-known/rat-things",
    "GET /__share/{token}",
    "GET /health",
    "GET /openapi.json",
    "GET /schemas/agents-api.schema.json",
    "GET /v1/integrations/oauth/callback",
  ], each.value) ? "NONE" : "AWS_IAM"
  target = "integrations/${aws_apigatewayv2_integration.lambda["control"].id}"
}

resource "aws_apigatewayv2_route" "agents_token_issuer" {
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "POST /v1/auth/tokens"
  authorization_type = "AWS_IAM"
  target             = "integrations/${aws_apigatewayv2_integration.agents_token_issuer.id}"
}

resource "aws_apigatewayv2_route" "webhook" {
  for_each = local.webhook_routes

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.key
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.lambda[each.value].id}"
}

resource "aws_lambda_permission" "api" {
  for_each = local.api_integrations

  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

resource "aws_lambda_permission" "agents_token_issuer_api" {
  statement_id  = "AllowApiGatewayTokenIssuer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["agents-token-issuer"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/POST/v1/auth/tokens"
}
