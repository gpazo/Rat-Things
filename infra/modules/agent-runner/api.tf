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
    # Generated Agents API routes; run npm run agents-api:routes.
    "GET /v1/agents/environments/{environment_id}",
    "GET /v1/agents/environments/{environment_id}/files",
    "POST /v1/agents/environments/{environment_id}/files",
    "POST /v1/agents",
    "GET /v1/agents",
    "GET /v1/agents/{agent_id}",
    "POST /v1/agents/{agent_id}",
    "DELETE /v1/agents/{agent_id}",
    "POST /v1/agents/environments/templates",
    "GET /v1/agents/environments/templates",
    "GET /v1/agents/environments/templates/{environment_template_id}",
    "POST /v1/agents/environments/templates/{environment_template_id}",
    "DELETE /v1/agents/environments/templates/{environment_template_id}",
    "POST /v1/agents/sessions",
    "GET /v1/agents/sessions",
    "GET /v1/agents/sessions/{session_id}",
    "POST /v1/agents/sessions/{session_id}",
    "DELETE /v1/agents/sessions/{session_id}",
    "POST /v1/agents/sessions/{session_id}/events",
    "GET /v1/agents/sessions/{session_id}/events",
    "GET /v1/agents/sessions/{session_id}/items",
    "GET /v1/agents/sessions/{session_id}/turns",
    "GET /v1/agents/sessions/{session_id}/turns/{turn_id}",
    "GET /v1/agents/sessions/{session_id}/artifacts",
    "GET /v1/agents/sessions/{session_id}/artifacts/{artifact_id}",
    "DELETE /v1/agents/sessions/{session_id}/artifacts/{artifact_id}",
    "GET /v1/agents/sessions/{session_id}/artifacts/{artifact_id}/content",
    "POST /v1/vaults",
    "GET /v1/vaults",
    "GET /v1/vaults/{vault_id}",
    "DELETE /v1/vaults/{vault_id}",
    "POST /v1/vaults/{vault_id}/credentials",
    "GET /v1/vaults/{vault_id}/credentials",
    "GET /v1/vaults/{vault_id}/credentials/{credential_id}",
    "POST /v1/vaults/{vault_id}/credentials/{credential_id}",
    "DELETE /v1/vaults/{vault_id}/credentials/{credential_id}",
    "GET /v1/agents/sessions/{session_id}/subagents",
    "GET /v1/agents/sessions/{session_id}/subagents/{subagent_id}",
    "GET /v1/agents/sessions/{session_id}/subagents/{subagent_id}/items",
    "GET /v1/agents/sessions/{session_id}/subagents/{subagent_id}/turns",
    "GET /v1/agents/sessions/{session_id}/subagents/{subagent_id}/turns/{turn_id}",
    "GET /v1/agents/sessions/{session_id}/subagents/{subagent_id}/turns/{turn_id}/items",
    "POST /v1/files",
    "GET /v1/files",
    "GET /v1/files/{file_id}",
    "DELETE /v1/files/{file_id}",
    "GET /v1/files/{file_id}/content",
    "POST /v1/skills",
    "GET /v1/skills",
    "GET /v1/skills/{skill_id}",
    "POST /v1/skills/{skill_id}",
    "DELETE /v1/skills/{skill_id}",
    "GET /v1/skills/{skill_id}/content",
    "GET /v1/skills/{skill_id}/versions",
    "POST /v1/skills/{skill_id}/versions",
    "GET /v1/skills/{skill_id}/versions/{version}",
    "DELETE /v1/skills/{skill_id}/versions/{version}",
    "GET /v1/skills/{skill_id}/versions/{version}/content",
    # End generated Agents API routes.
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
