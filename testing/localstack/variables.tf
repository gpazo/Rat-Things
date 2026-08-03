variable "aws_region" {
  description = "Region reported by LocalStack."
  type        = string
  default     = "us-east-1"
}

variable "localstack_endpoint" {
  description = "LocalStack endpoint as seen from the Terraform container."
  type        = string
  default     = "http://localstack:4566"
}

variable "teams_signing_secret" {
  description = "Base64-encoded HMAC key used only by the local Teams fixture."
  type        = string
  default     = "bG9jYWxzdGFjay10ZWFtcy1zaWduaW5nLWtleQ=="
  sensitive   = true
}

variable "teams_workflow_url" {
  description = "WireMock Teams Workflow URL as seen by host-side handlers."
  type        = string
  default     = "http://localhost:8080/teams/workflow"
}
