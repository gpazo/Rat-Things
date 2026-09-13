variable "enable_ec2_worker" {
  type        = bool
  default     = false
  description = "Use dedicated ARM64 EC2 workers for persistent Sessions. Requires S3 Files and pinned AMI/image inputs."
}

variable "ec2_worker_ami_id" {
  type        = string
  default     = null
  description = "Pinned Amazon Linux 2023 ARM64 AMI with AWS CLI and dnf."
  validation {
    condition     = var.ec2_worker_ami_id == null ? true : can(regex("^ami-[0-9a-f]+$", var.ec2_worker_ami_id))
    error_message = "ec2_worker_ami_id must be an AMI ID."
  }
}

variable "ec2_worker_image" {
  type        = string
  default     = null
  description = "Private ECR ARM64 worker image pinned by sha256 digest."
  validation {
    condition     = var.ec2_worker_image == null ? true : can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9/_-]+@sha256:[0-9a-f]{64}$", var.ec2_worker_image))
    error_message = "ec2_worker_image must be a private ECR image pinned by digest."
  }
}

variable "ec2_worker_instance_type" {
  type    = string
  default = "m7g.large"
  validation {
    condition     = contains(["m7g.large", "m7g.xlarge", "m7g.2xlarge"], var.ec2_worker_instance_type)
    error_message = "Choose a supported ARM64 worker instance size."
  }
}

locals {
  ec2_worker_prefix = "arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}"
}

data "aws_iam_policy_document" "ec2_worker_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_worker" {
  count              = var.enable_ec2_worker ? 1 : 0
  name               = "${local.name}-session-worker"
  assume_role_policy = data.aws_iam_policy_document.ec2_worker_assume.json
  tags               = local.tags
}

resource "aws_iam_instance_profile" "ec2_worker" {
  count = var.enable_ec2_worker ? 1 : 0
  name  = "${local.name}-session-worker"
  role  = aws_iam_role.ec2_worker[0].name
}

data "aws_iam_policy_document" "ec2_worker" {
  count                   = var.enable_ec2_worker ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.worker.json]
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ec2_worker[0].arn}:*"]
  }
  statement {
    actions   = ["dynamodb:Query", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.agents.arn]
  }
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = ["arn:${data.aws_partition.current.partition}:ecr:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:repository/${try(split("@", join("/", slice(split("/", var.ec2_worker_image), 1, length(split("/", var.ec2_worker_image)))))[0], "UNPROVISIONED")}"]
  }
}

resource "aws_iam_role_policy" "ec2_worker" {
  count  = var.enable_ec2_worker ? 1 : 0
  name   = "worker"
  role   = aws_iam_role.ec2_worker[0].id
  policy = data.aws_iam_policy_document.ec2_worker[0].json
}

resource "aws_cloudwatch_log_group" "ec2_worker" {
  count             = var.enable_ec2_worker ? 1 : 0
  name              = "/rat-things/${local.name}/session-worker"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_launch_template" "session_worker" {
  count                                = var.enable_ec2_worker ? 1 : 0
  name_prefix                          = "${local.name}-session-"
  image_id                             = var.ec2_worker_ami_id
  instance_type                        = var.ec2_worker_instance_type
  instance_initiated_shutdown_behavior = "terminate"
  update_default_version               = false
  iam_instance_profile {
    arn = aws_iam_instance_profile.ec2_worker[0].arn
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    http_protocol_ipv6          = "disabled"
    instance_metadata_tags      = "enabled"
  }
  network_interfaces {
    associate_public_ip_address = false
    delete_on_termination       = true
    device_index                = 0
    subnet_id                   = aws_subnet.s3_files_private[0].id
    security_groups             = [aws_security_group.s3_files_client[0].id]
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      encrypted             = true
      delete_on_termination = true
      volume_size           = 40
      volume_type           = "gp3"
    }
  }
  user_data = base64encode(templatefile("${path.module}/ec2-worker.sh.tftpl", {
    region    = data.aws_region.current.region
    image     = coalesce(var.ec2_worker_image, "UNPROVISIONED")
    registry  = try(split("/", var.ec2_worker_image)[0], "UNPROVISIONED")
    log_group = aws_cloudwatch_log_group.ec2_worker[0].name
    configuration = base64encode(jsonencode(merge(local.worker_environment, {
      AWS_REGION                       = data.aws_region.current.region, DEFAULT_EXECUTION_BACKEND = "ec2",
      ALLOW_AGENT_AWS_CREDENTIAL_CHAIN = "false",
    })))
  }))
  tags = local.tags
  lifecycle {
    precondition {
      condition     = var.enable_s3_files && var.ec2_worker_ami_id != null && var.ec2_worker_image != null
      error_message = "EC2 workers require S3 Files and pinned AMI/image inputs."
    }
  }
  depends_on = [aws_iam_role_policy.ec2_worker]
}

data "aws_iam_policy_document" "ec2_dispatch" {
  count = var.enable_ec2_worker ? 1 : 0
  statement {
    actions = ["ec2:RunInstances"]
    resources = [
      aws_launch_template.session_worker[0].arn,
      "arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.region}::image/${var.ec2_worker_ami_id}",
      "${local.ec2_worker_prefix}:subnet/${aws_subnet.s3_files_private[0].id}",
      "${local.ec2_worker_prefix}:security-group/${aws_security_group.s3_files_client[0].id}",
      "${local.ec2_worker_prefix}:instance/*", "${local.ec2_worker_prefix}:volume/*", "${local.ec2_worker_prefix}:network-interface/*",
    ]
    condition {
      test     = "ArnEquals"
      variable = "ec2:LaunchTemplate"
      values   = [aws_launch_template.session_worker[0].arn]
    }
  }
  statement {
    actions   = ["ec2:CreateTags"]
    resources = ["${local.ec2_worker_prefix}:instance/*", "${local.ec2_worker_prefix}:volume/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances"]
    }
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ec2_worker[0].arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "ec2_dispatch" {
  count  = var.enable_ec2_worker ? 1 : 0
  name   = "ec2-session-launch"
  role   = aws_iam_role.dispatcher.id
  policy = data.aws_iam_policy_document.ec2_dispatch[0].json
}

data "aws_iam_policy_document" "ec2_control" {
  count = var.enable_ec2_worker ? 1 : 0
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
  statement {
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
  statement {
    actions   = ["ec2:TerminateInstances"]
    resources = ["${local.ec2_worker_prefix}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/RatDeployment"
      values   = [local.name]
    }
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:TransactWriteItems"]
    resources = [aws_dynamodb_table.agents.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.definitions.arn}/owners/*"]
  }
}

resource "aws_iam_role_policy" "ec2_control" {
  for_each = var.enable_ec2_worker ? merge({
    control    = aws_iam_role.control.id, dispatcher = aws_iam_role.dispatcher.id,
    reconciler = aws_iam_role.reconciler.id, outbox = aws_iam_role.agents_outbox.id,
  }, local.environment_relay_enabled ? { http = aws_iam_role.agents_http[0].id } : {}) : {}
  name   = "ec2-session-control"
  role   = each.value
  policy = data.aws_iam_policy_document.ec2_control[0].json
}
