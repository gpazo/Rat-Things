output "api_endpoint" {
  value = module.agent_runner.api_endpoint
}

output "webhook_urls" {
  value = module.agent_runner.webhook_urls
}

output "artifact_bucket_name" {
  value = module.agent_runner.artifact_bucket_name
}

output "runs_table_name" {
  value = module.agent_runner.runs_table_name
}

output "run_queue_url" {
  value = module.agent_runner.run_queue_url
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

output "worker_repository_url" {
  value = module.agent_runner.worker_repository_url
}

output "ecs_cluster_arn" {
  value = module.agent_runner.ecs_cluster_arn
}

output "ecs_task_definition_arn" {
  value = module.agent_runner.ecs_task_definition_arn
}

output "microvm" {
  value = {
    enabled                 = module.agent_runner.microvm_enabled
    image_arn               = module.agent_runner.microvm_image_arn
    image_version           = module.agent_runner.microvm_image_version
    image_state             = module.agent_runner.microvm_image_state
    network_connector_arn   = module.agent_runner.microvm_network_connector_arn
    network_connector_state = module.agent_runner.microvm_network_connector_state
  }
}

output "github_webhook_secret_arn" {
  value = aws_secretsmanager_secret.github_webhook.arn
}

output "gitlab_webhook_secret_arn" {
  value = aws_secretsmanager_secret.gitlab_webhook.arn
}
