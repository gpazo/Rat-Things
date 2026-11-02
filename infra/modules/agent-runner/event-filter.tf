variable "event_filter_model_id" {
  description = "Opt-in Bedrock Converse model or inference profile supporting JSON-schema output for candidate filtering. Null drops candidates without inference."
  type        = string
  default     = null
  validation {
    condition     = var.event_filter_model_id == null || length(var.event_filter_inference_resource_arns) > 0
    error_message = "Candidate filtering requires exact approved inference resource ARNs."
  }
}

variable "event_filter_inference_resource_arns" {
  description = "Exact model and inference-profile ARNs the candidate filter may invoke."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for arn in var.event_filter_inference_resource_arns : startswith(arn, "arn:") && !strcontains(arn, "*")])
    error_message = "Event filter inference resources must be exact ARNs without wildcards."
  }
}

variable "slack_candidate_events_enabled" {
  description = "Opt in to Slack message events and history scopes. Requires a separate Slack app installation with message.channels and message.groups subscriptions."
  type        = bool
  default     = false
}
