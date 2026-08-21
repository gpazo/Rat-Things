output "test_environment" {
  description = "Stable environment contract consumed by the host-side E2E test."
  sensitive   = true
  value = {
    ARTIFACT_BUCKET                    = aws_s3_bucket.artifacts.id
    CONVERSATIONS_TABLE_NAME           = aws_dynamodb_table.conversations.name
    CONVERSATION_QUEUE_URL             = aws_sqs_queue.conversations.url
    EVENT_BUS_NAME                     = aws_cloudwatch_event_bus.runs.name
    GITHUB_WEBHOOK_SECRET_ARN          = aws_secretsmanager_secret.github_webhook.name
    GITHUB_WEBHOOK_SIGNING_SECRET      = "localstack-github-webhook-secret"
    GITLAB_WEBHOOK_SECRET_ARN          = aws_secretsmanager_secret.gitlab_webhook.name
    GITLAB_WEBHOOK_SIGNING_TOKEN       = "whsec_bG9jYWxzdGFjay1naXRsYWItc2lnbmluZy1rZXkhISE="
    INTEGRATIONS_TABLE_NAME            = aws_dynamodb_table.integrations.name
    INTEGRATION_CREDENTIAL_NAME_PREFIX = "${local.name}/connections"
    RUNS_TABLE_NAME                    = aws_dynamodb_table.runs.name
    ROUTINES_TABLE_NAME                = aws_dynamodb_table.routines.name
    RUN_QUEUE_URL                      = aws_sqs_queue.runs.url
    TERMINAL_EVENTS_QUEUE_URL          = aws_sqs_queue.terminal_events.url
    TEAMS_OUTGOING_WEBHOOK_SECRET_ARN  = aws_secretsmanager_secret.teams_webhook.name
    TEAMS_REPLY_GATEWAY_URL_SECRET_ARN = aws_secretsmanager_secret.teams_reply_gateway.name
    TEAMS_WORKFLOW_URL_SECRET_ARN      = aws_secretsmanager_secret.teams_workflow.name
    TEAMS_SIGNING_SECRET               = var.teams_signing_secret
  }
}

output "runs_stream_arn" {
  value = aws_dynamodb_table.runs.stream_arn
}
