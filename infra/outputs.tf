output "api_endpoint" {
  value = module.agent_runner.api_endpoint
}

output "control_routes" {
  value = module.agent_runner.control_routes
}

output "webhook_urls" {
  value = module.agent_runner.webhook_urls
}

output "artifact_bucket_name" {
  value = module.agent_runner.artifact_bucket_name
}

output "conversation_state_bucket_name" {
  value = module.agent_runner.conversation_state_bucket_name
}

output "runs_table_name" {
  value = module.agent_runner.runs_table_name
}

output "conversations_table_name" {
  value = module.agent_runner.conversations_table_name
}

output "integrations_table_name" {
  value = module.agent_runner.integrations_table_name
}

output "routines_table_name" {
  value = module.agent_runner.routines_table_name
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

output "event_bus_name" {
  value = module.agent_runner.event_bus_name
}

output "microvm" {
  description = "Lambda MicroVM runner outputs."
  value = {
    enabled                 = module.agent_runner.microvm_enabled
    image_arn               = module.agent_runner.microvm_image_arn
    image_version           = module.agent_runner.microvm_image_version
    image_state             = module.agent_runner.microvm_image_state
    execution_role_arn      = module.agent_runner.microvm_execution_role_arn
    log_group_name          = module.agent_runner.microvm_log_group_name
    image_version_parameter = module.agent_runner.microvm_image_version_parameter_name
  }
}

output "s3_files" {
  description = "Durable conversation filesystem outputs."
  value       = module.agent_runner.s3_files
}

output "publication_delivery" {
  description = "Isolated file, site, and video publication delivery outputs."
  value       = module.agent_runner.publication_delivery
}
