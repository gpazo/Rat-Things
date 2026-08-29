output "api_endpoint" {
  value = module.agent_runner.api_endpoint
}

output "oauth_callback_url" {
  value = module.agent_runner.oauth_callback_url
}

output "webhook_urls" {
  value = module.agent_runner.webhook_urls
}

output "slack_webhook_secret_arn" {
  value = try(aws_secretsmanager_secret.slack_webhook[0].arn, null)
}

output "artifact_bucket_name" {
  value = module.agent_runner.artifact_bucket_name
}

output "definition_bucket_name" {
  value = module.agent_runner.definition_bucket_name
}

output "conversation_state_bucket_name" {
  value = module.agent_runner.conversation_state_bucket_name
}

output "s3_files" {
  value = module.agent_runner.s3_files
}

output "publication_delivery" {
  value = module.agent_runner.publication_delivery
}

output "publication_signing_key_secret_arn" {
  value = try(aws_secretsmanager_secret.publication_signing_key[0].arn, null)
}

output "runs_table_name" {
  value = module.agent_runner.runs_table_name
}

output "reconciler_function_name" {
  value = module.agent_runner.reconciler_function_name
}

output "conversations_table_name" {
  value = module.agent_runner.conversations_table_name
}

output "integrations_table_name" {
  value = module.agent_runner.integrations_table_name
}

output "things_table_name" {
  value = module.agent_runner.things_table_name
}

output "thing_schedule_group_name" {
  value = module.agent_runner.thing_schedule_group_name
}

output "thing_schedule_failure_queue_url" {
  value = module.agent_runner.thing_schedule_failure_queue_url
}

output "run_queue_url" {
  value = module.agent_runner.run_queue_url
}

output "conversation_queue_url" {
  value = module.agent_runner.conversation_queue_url
}

output "conversation_failure_queue_url" {
  value = module.agent_runner.conversation_failure_queue_url
}

output "conversation_completion_failure_queue_url" {
  value = module.agent_runner.conversation_completion_failure_queue_url
}

output "run_failure_queue_url" {
  value = module.agent_runner.run_failure_queue_url
}

output "state_stream_failure_queue_url" {
  value = module.agent_runner.state_stream_failure_queue_url
}

output "notifier_delivery_failure_queue_url" {
  value = module.agent_runner.notifier_delivery_failure_queue_url
}

output "terminal_events_queue_url" {
  value = aws_sqs_queue.terminal_events.url
}

output "delivery_capture_queue_url" {
  value = aws_sqs_queue.delivery_capture.url
}

output "delivery_capture_url" {
  value = "${aws_apigatewayv2_api.delivery_capture.api_endpoint}/teams"
}

output "integration_fixture_url" {
  value = aws_lambda_function_url.integration_fixture.function_url
}

output "integration_fixture_audit_queue_url" {
  value = aws_sqs_queue.integration_fixture_audit.url
}

output "microvm" {
  value = {
    enabled       = module.agent_runner.microvm_enabled
    image_arn     = module.agent_runner.microvm_image_arn
    image_version = module.agent_runner.microvm_image_version
    image_state   = module.agent_runner.microvm_image_state
  }
}

output "github_webhook_secret_arn" {
  value = aws_secretsmanager_secret.github_webhook.arn
}

output "gitlab_webhook_secret_arn" {
  value = aws_secretsmanager_secret.gitlab_webhook.arn
}

output "teams_webhook_secret_arn" {
  value = aws_secretsmanager_secret.teams_webhook.arn
}

output "teams_workflow_secret_arn" {
  value = aws_secretsmanager_secret.teams_workflow.arn
}
