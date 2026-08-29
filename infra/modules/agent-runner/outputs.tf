output "api_endpoint" {
  description = "Base URL for the HTTP API. Control routes require SigV4 unless explicitly documented as public."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "oauth_callback_url" {
  description = "Register this exact redirect URL with every OAuth application configured for an integration plugin."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/v1/integrations/oauth/callback"
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

output "definition_bucket_name" {
  description = "Non-expiring encrypted S3 bucket holding immutable Thing definitions."
  value       = aws_s3_bucket.definitions.id
}

output "conversation_state_bucket_name" {
  description = "S3 bucket backing durable S3 Files conversation state, or null when disabled."
  value       = try(aws_s3_bucket.conversation_state[0].id, null)
}

output "s3_files" {
  description = "Durable conversation filesystem identifiers, or null values when S3 Files is disabled."
  value = {
    enabled                 = var.enable_s3_files
    file_system_id          = try(aws_s3files_file_system.conversation_state[0].id, null)
    access_point_id         = try(aws_s3files_access_point.conversation_state[0].id, null)
    mount_target_id         = try(aws_s3files_mount_target.conversation_state[0].id, null)
    mount_target_ip         = try(aws_s3files_mount_target.conversation_state[0].ipv4_address, null)
    network_connector_arn   = try(awscc_lambda_network_connector.s3_files[0].arn, null)
    network_connector_state = try(awscc_lambda_network_connector.s3_files[0].state, null)
  }
}

output "publication_delivery" {
  description = "Isolated CloudFront publication delivery outputs, or null values when disabled."
  value = {
    enabled                  = local.publication_delivery_enabled
    base_domain              = local.publication_delivery_enabled ? local.publication_domain : null
    distribution_id          = try(aws_cloudfront_distribution.publications[0].id, null)
    distribution_domain_name = try(aws_cloudfront_distribution.publications[0].domain_name, null)
    route53_records_managed  = local.publication_delivery_enabled && var.publication_route53_zone_id != null
  }
}

output "microvm_source_bucket_name" {
  value = aws_s3_bucket.microvm_source.id
}

output "runs_table_name" {
  value = aws_dynamodb_table.runs.name
}

output "conversations_table_name" {
  description = "DynamoDB table holding conversation mailbox, lease, turn, and history projections."
  value       = aws_dynamodb_table.conversations.name
}

output "integrations_table_name" {
  description = "DynamoDB table holding owner-scoped connection metadata, grants, sets, and source bindings."
  value       = aws_dynamodb_table.integrations.name
}

output "routines_table_name" {
  description = "DynamoDB table holding owner-scoped routine schedules and encrypted request references."
  value       = aws_dynamodb_table.routines.name
}

output "things_table_name" {
  description = "DynamoDB table holding owner-scoped Thing lifecycle metadata and immutable version references."
  value       = aws_dynamodb_table.things.name
}

output "thing_schedule_group_name" {
  description = "EventBridge Scheduler group containing deployment-owned Thing schedules."
  value       = aws_scheduler_schedule_group.things.name
}

output "thing_schedule_failure_queue_url" {
  description = "Dead-letter queue for Thing schedules that exhaust target retries."
  value       = aws_sqs_queue.thing_schedule_failures.url
}

output "run_queue_url" {
  value = aws_sqs_queue.runs.url
}

output "run_queue_arn" {
  value = aws_sqs_queue.runs.arn
}

output "conversation_queue_url" {
  description = "Wake-up queue for durable conversation mailbox work."
  value       = aws_sqs_queue.conversations.url
}

output "conversation_failure_queue_url" {
  description = "Dead-letter queue for conversation wake-ups that exhaust receives."
  value       = aws_sqs_queue.conversation_dlq.url
}

output "conversation_completion_failure_queue_url" {
  description = "Dead-letter queue for terminal conversation events that exhaust completion retries."
  value       = aws_sqs_queue.conversation_completion_failures.url
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

output "microvm_enabled" {
  value = var.enable_microvm
}

output "microvm_image_arn" {
  value = try(awscc_lambda_microvm_image.runner[0].image_arn, null)
}

output "microvm_image_version" {
  value = try(data.awscc_lambda_microvm_image.runner[0].latest_active_image_version, null)
}

output "microvm_image_state" {
  value = try(awscc_lambda_microvm_image.runner[0].state, null)
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

output "microvm_log_group_name" {
  value = aws_cloudwatch_log_group.microvm.name
}

output "reconciler_function_name" {
  description = "Generation-fenced Run reconciler Lambda name."
  value       = aws_lambda_function.this["reconciler"].function_name
}
