# Provider mocks evaluate both backend graphs without credentials or AWS calls.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:root" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-west-2", name = "us-west-2" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-west-2:123456789012:log-group:test" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/microvm" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::123456789012:instance-profile/ec2-worker" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-west-2:123456789012:function:test" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:us-west-2:123456789012:test" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-west-2:123456789012:rule/test" }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = { execution_arn = "arn:aws:execute-api:us-west-2:123456789012:test" }
  }
  mock_resource "aws_subnet" {
    defaults = { id = "subnet-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0" }
  }
  override_resource {
    target = aws_iam_role.ec2_worker
    values = { arn = "arn:aws:iam::123456789012:role/ec2-worker" }
  }
}
mock_provider "awscc" {
}

variables {
  # Mock providers do not consume archives. This existing fixture satisfies the
  # path checks; separate packaging/image gates validate real executable bytes.
  lambda_zip_paths = { for name in [
    "agents-api", "agents-outbox", "connection-health", "control", "dispatcher", "notifier",
    "reconciler", "state-stream", "thing-schedule", "webhook-github", "webhook-gitlab", "webhook-teams", "webhook-slack"
  ] : name => "tests/worker-backends.tftest.hcl" }
  microvm_source_zip_path    = "tests/worker-backends.tftest.hcl"
  enable_s3_files            = true
  codex_auth_mode            = "bedrock"
  ec2_worker_ami_id          = "ami-0123456789abcdef0"
  ec2_worker_image           = "123456789012.dkr.ecr.us-west-2.amazonaws.com/worker@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  microvm_base_image_version = "1"
}

run "ec2_only_storage" {
  command = apply
  module { source = "./modules/agent-runner" }
  variables {
    enable_microvm    = false
    enable_ec2_worker = true
  }
  assert {
    condition     = length(aws_launch_template.session_worker) == 1 && length(awscc_lambda_network_connector.s3_files) == 0
    error_message = "EC2-only storage must not provision a Lambda network connector."
  }
  assert {
    condition     = local.worker_environment.S3_FILES_ENABLED == "true" && !contains(keys(local.worker_environment), "MICROVM_VPC_NETWORK_CONNECTOR_ARN")
    error_message = "EC2 workers require mount coordinates without a MicroVM connector dependency."
  }
  assert {
    condition     = jsondecode(aws_s3files_file_system_policy.conversation_state[0].policy).Statement[0].Principal.AWS == ["arn:aws:iam::123456789012:role/ec2-worker"]
    error_message = "The storage policy must admit the enabled EC2 worker role."
  }
}

run "both_worker_backends" {
  command = apply
  module { source = "./modules/agent-runner" }
  variables {
    enable_microvm    = true
    enable_ec2_worker = true
  }
  assert {
    condition     = length(awscc_lambda_network_connector.s3_files) == 1 && contains(keys(local.worker_environment), "MICROVM_VPC_NETWORK_CONNECTOR_ARN")
    error_message = "An enabled MicroVM backend still requires its storage network connector."
  }
  assert {
    condition     = toset(jsondecode(aws_s3files_file_system_policy.conversation_state[0].policy).Statement[0].Principal.AWS) == toset(["arn:aws:iam::123456789012:role/microvm", "arn:aws:iam::123456789012:role/ec2-worker"])
    error_message = "Both enabled worker roles must be admitted to the same retained access point."
  }
}
