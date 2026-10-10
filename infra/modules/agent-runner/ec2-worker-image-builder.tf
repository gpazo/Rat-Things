locals {
  ec2_worker_builder_enabled    = var.enable_ec2_worker_ami_pipeline
  ec2_worker_builder_image      = coalesce(var.ec2_worker_image, "UNPROVISIONED")
  ec2_worker_builder_registry   = try(split("/", var.ec2_worker_image)[0], "UNPROVISIONED")
  ec2_worker_builder_repository = try(split("@", join("/", slice(split("/", var.ec2_worker_image), 1, length(split("/", var.ec2_worker_image)))))[0], "UNPROVISIONED")
  ec2_worker_builder_definition_hash = substr(sha256(jsonencode({
    source_hash       = filesha256("${path.module}/ec2-worker-image-builder.tf")
    image             = local.ec2_worker_builder_image
    component_version = var.ec2_worker_ami_component_version
    region            = data.aws_region.current.region
  })), 0, 12)
  prepared_worker_image = local.ec2_worker_builder_enabled ? {
    parent_ami_id     = var.ec2_worker_ami_base_id
    ecr_digest        = local.ec2_worker_builder_image
    component_version = var.ec2_worker_ami_component_version
    recipe_version    = var.ec2_worker_ami_recipe_version
    definition_hash   = local.ec2_worker_builder_definition_hash
  } : null
}

data "aws_iam_policy_document" "ec2_worker_image_builder_assume" {
  count = local.ec2_worker_builder_enabled ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_worker_image_builder" {
  count              = local.ec2_worker_builder_enabled ? 1 : 0
  name               = "${local.name}-worker-image-builder"
  assume_role_policy = data.aws_iam_policy_document.ec2_worker_image_builder_assume[0].json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ec2_worker_image_builder" {
  for_each = local.ec2_worker_builder_enabled ? toset([
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/EC2InstanceProfileForImageBuilder",
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ]) : toset([])
  role       = aws_iam_role.ec2_worker_image_builder[0].name
  policy_arn = each.value
}

data "aws_iam_policy_document" "ec2_worker_image_builder" {
  count = local.ec2_worker_builder_enabled ? 1 : 0
  statement {
    sid       = "PullPinnedWorkerImage"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = ["arn:${data.aws_partition.current.partition}:ecr:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:repository/${local.ec2_worker_builder_repository}"]
  }
  statement {
    sid       = "AuthenticateToEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "WriteBuildLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/image-builder/*"]
  }
  statement {
    sid       = "UseDataKey"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"]
    resources = [aws_kms_key.data.arn]
  }
  statement {
    sid       = "GrantDataKeyToAwsResources"
    actions   = ["kms:CreateGrant"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "ec2_worker_image_builder" {
  count  = local.ec2_worker_builder_enabled ? 1 : 0
  name   = "prepared-worker-image"
  role   = aws_iam_role.ec2_worker_image_builder[0].id
  policy = data.aws_iam_policy_document.ec2_worker_image_builder[0].json
}

resource "aws_iam_instance_profile" "ec2_worker_image_builder" {
  count = local.ec2_worker_builder_enabled ? 1 : 0
  name  = "${local.name}-worker-image-builder"
  role  = aws_iam_role.ec2_worker_image_builder[0].name
}

resource "aws_imagebuilder_component" "ec2_worker" {
  count       = local.ec2_worker_builder_enabled ? 1 : 0
  name        = "${local.name}-prepared-worker-${local.ec2_worker_builder_definition_hash}"
  description = "Install the ARM64 worker prerequisites and cache one digest-pinned runtime image."
  platform    = "Linux"
  version     = var.ec2_worker_ami_component_version
  data = yamlencode({
    name          = "${local.name}-prepared-worker"
    description   = "Prepare a worker AMI without retaining registry credentials."
    schemaVersion = 1.0
    phases = [{
      name = "build"
      steps = [{
        name   = "PrepareWorker"
        action = "ExecuteBash"
        inputs = { commands = [
          "set -euo pipefail",
          "test \"$(uname -m)\" = aarch64",
          ". /etc/os-release && test \"$ID\" = amzn && test \"$VERSION_ID\" = 2023",
          "dnf install -y docker iptables",
          "systemctl enable docker",
          "systemctl start docker",
          "aws ecr get-login-password --region '${data.aws_region.current.region}' | docker login --username AWS --password-stdin '${local.ec2_worker_builder_registry}'",
          "docker pull '${local.ec2_worker_builder_image}'",
          "test \"$(docker image inspect --format '{{.Architecture}}' '${local.ec2_worker_builder_image}')\" = arm64",
          "docker image inspect '${local.ec2_worker_builder_image}' >/dev/null",
          "docker logout '${local.ec2_worker_builder_registry}'",
          "rm -rf /root/.docker",
          "systemctl stop docker",
        ] }
      }]
      }, {
      name = "validate"
      steps = [{
        name   = "ValidatePreparedWorker"
        action = "ExecuteBash"
        inputs = { commands = [
          "set -euo pipefail",
          "systemctl start docker",
          "docker image inspect '${local.ec2_worker_builder_image}' >/dev/null",
          "test \"$(docker image inspect --format '{{.Architecture}}' '${local.ec2_worker_builder_image}')\" = arm64",
          "docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' '${local.ec2_worker_builder_image}' | grep -Fx '${local.ec2_worker_builder_image}' >/dev/null",
          "docker run --pull=never --rm --entrypoint sh '${local.ec2_worker_builder_image}' -c 'node --version >/dev/null && /opt/codex-runtime/bin/codex --version >/dev/null && test -r /opt/agent-runtime/ec2-supervisor.mjs'",
          "test ! -e /root/.docker/config.json",
          "systemctl stop docker",
        ] }
      }]
      }, {
      name = "test"
      steps = [{
        name   = "TestPreparedWorker"
        action = "ExecuteBash"
        inputs = { commands = [
          "set -euo pipefail",
          "test \"$(uname -m)\" = aarch64",
          "systemctl start docker",
          "docker run --network none --pull=never --rm --entrypoint sh '${local.ec2_worker_builder_image}' -c 'node --version >/dev/null && /opt/codex-runtime/bin/codex --version >/dev/null && test -r /opt/agent-runtime/ec2-supervisor.mjs && node --check /opt/agent-runtime/ec2-supervisor.mjs'",
          "systemctl stop docker",
        ] }
      }]
    }]
  })
  tags = local.tags
  lifecycle { create_before_destroy = true }
}

resource "aws_imagebuilder_image_recipe" "ec2_worker" {
  count        = local.ec2_worker_builder_enabled ? 1 : 0
  name         = "${local.name}-prepared-worker-${substr(sha256(jsonencode(local.prepared_worker_image)), 0, 12)}"
  description  = "ARM64 EC2 worker with the exact runtime image already present."
  parent_image = var.ec2_worker_ami_base_id
  version      = var.ec2_worker_ami_recipe_version
  component {
    component_arn = aws_imagebuilder_component.ec2_worker[0].arn
  }
  block_device_mapping {
    device_name = "/dev/xvda"
    ebs {
      delete_on_termination = "true"
      encrypted             = "true"
      kms_key_id            = aws_kms_key.data.arn
      volume_size           = 40
      volume_type           = "gp3"
    }
  }
  systems_manager_agent { uninstall_after_build = false }
  tags = local.tags
  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = var.enable_s3_files && var.ec2_worker_ami_base_id != null && var.ec2_worker_image != null
      error_message = "The worker AMI pipeline requires S3 Files networking, a pinned ARM64 base AMI, and a digest-pinned worker image."
    }
  }
}

resource "aws_imagebuilder_infrastructure_configuration" "ec2_worker" {
  count                         = local.ec2_worker_builder_enabled ? 1 : 0
  name                          = "${local.name}-prepared-worker"
  description                   = "Private ARM64 build host for prepared Session worker AMIs."
  instance_profile_name         = aws_iam_instance_profile.ec2_worker_image_builder[0].name
  instance_types                = [var.ec2_worker_instance_type]
  subnet_id                     = aws_subnet.s3_files_private[0].id
  security_group_ids            = [aws_security_group.s3_files_client[0].id]
  terminate_instance_on_failure = true
  instance_metadata_options {
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
  }
  logging {
    s3_logs {
      s3_bucket_name = aws_s3_bucket.artifacts.id
      s3_key_prefix  = "image-builder"
    }
  }
  resource_tags = merge(local.tags, { Name = "${local.name}-worker-image-build" })
  tags          = local.tags
  depends_on = [
    aws_iam_role_policy.ec2_worker_image_builder,
    aws_iam_role_policy_attachment.ec2_worker_image_builder,
  ]
}

resource "aws_imagebuilder_distribution_configuration" "ec2_worker" {
  count       = local.ec2_worker_builder_enabled ? 1 : 0
  name        = "${local.name}-prepared-worker"
  description = "Keep prepared worker AMIs private to this account and Region."
  distribution {
    region = data.aws_region.current.region
    ami_distribution_configuration {
      name        = "${local.name}-worker-{{ imagebuilder:buildDate }}"
      description = "Prepared ARM64 worker from ${var.ec2_worker_ami_recipe_version}."
      kms_key_id  = aws_kms_key.data.arn
      ami_tags    = merge(local.tags, { Name = "${local.name}-prepared-worker" })
    }
  }
  tags = local.tags
}

resource "aws_imagebuilder_image_pipeline" "ec2_worker" {
  count                            = local.ec2_worker_builder_enabled ? 1 : 0
  name                             = "${local.name}-prepared-worker"
  description                      = "Explicitly triggered pipeline for prepared ARM64 Session workers."
  image_recipe_arn                 = aws_imagebuilder_image_recipe.ec2_worker[0].arn
  infrastructure_configuration_arn = aws_imagebuilder_infrastructure_configuration.ec2_worker[0].arn
  distribution_configuration_arn   = aws_imagebuilder_distribution_configuration.ec2_worker[0].arn
  enhanced_image_metadata_enabled  = true
  status                           = "ENABLED"
  image_tests_configuration {
    image_tests_enabled = true
    timeout_minutes     = 60
  }
  tags = local.tags
}
