output "api_endpoint" {
  description = "Base URL for the HTTP API. Control routes require SigV4 unless explicitly documented as public."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "control_routes" {
  description = "IAM-authenticated control routes exposed by the subsystem."
  value       = sort(tolist(local.control_routes))
}

output "webhook_urls" {
  description = "Enabled unauthenticated-but-signature-verified webhook URLs."
  value = merge(
    local.github_enabled ? { github = "${aws_apigatewayv2_api.this.api_endpoint}/webhooks/github" } : {},
    local.gitlab_enabled ? { gitlab = "${aws_apigatewayv2_api.this.api_endpoint}/webhooks/gitlab" } : {},
    local.teams_enabled ? { teams = "${aws_apigatewayv2_api.this.api_endpoint}/webhooks/teams" } : {},
    local.slack_enabled ? { slack = "${aws_apigatewayv2_api.this.api_endpoint}/webhooks/slack" } : {},
  )
}

output "artifact_bucket_name" {
  value = aws_s3_bucket.artifacts.id
}

output "microvm_source_bucket_name" {
  value = aws_s3_bucket.microvm_source.id
}

output "runs_table_name" {
  value = aws_dynamodb_table.runs.name
}

output "run_queue_url" {
  value = aws_sqs_queue.runs.url
}

output "run_queue_arn" {
  value = aws_sqs_queue.runs.arn
}

output "run_failure_queue_url" {
  description = "Dead-letter queue for run dispatch messages that exhaust receives."
  value       = aws_sqs_queue.run_dlq.url
}

output "state_stream_failure_queue_url" {
  description = "On-failure destination for DynamoDB stream invocations that exhaust retries."
  value       = aws_sqs_queue.state_stream_failures.url
}

output "notifier_delivery_failure_queue_url" {
  description = "Dead-letter queue for terminal events that exhaust EventBridge notifier-target retries."
  value       = aws_sqs_queue.notifier_delivery_failures.url
}

output "event_bus_name" {
  value = aws_cloudwatch_event_bus.runs.name
}

output "worker_repository_url" {
  description = "Push the linux/arm64 agent-runner image to this ECR repository."
  value       = aws_ecr_repository.worker.repository_url
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "ecs_task_definition_arn" {
  value = aws_ecs_task_definition.worker.arn
}

output "runner_private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "runner_security_group_id" {
  value = aws_security_group.runner.id
}

output "microvm_enabled" {
  value = var.enable_microvm
}

output "microvm_image_arn" {
  value = try(awscc_lambda_microvm_image.runner[0].image_arn, null)
}

output "microvm_image_version" {
  value = try(awscc_lambda_microvm_image.runner[0].latest_active_image_version, null)
}

output "microvm_image_state" {
  value = try(awscc_lambda_microvm_image.runner[0].state, null)
}

output "microvm_network_connector_arn" {
  value = try(awscc_lambda_network_connector.runner[0].arn, null)
}

output "microvm_network_connector_state" {
  value = try(awscc_lambda_network_connector.runner[0].state, null)
}

output "microvm_execution_role_arn" {
  value = aws_iam_role.microvm_execution.arn
}

output "microvm_image_parameter_name" {
  value = aws_ssm_parameter.microvm_image.name
}

output "microvm_image_version_parameter_name" {
  value = aws_ssm_parameter.microvm_image_version.name
}

output "microvm_connector_parameter_name" {
  value = aws_ssm_parameter.microvm_connector.name
}

output "microvm_log_group_name" {
  value = aws_cloudwatch_log_group.microvm.name
}
