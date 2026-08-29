locals {
  microvm_source_sha256     = fileexists(local.microvm_source_zip_path) ? filesha256(local.microvm_source_zip_path) : "missing"
  microvm_source_object_key = "microvm/source-${local.microvm_source_sha256}.zip"
}

resource "aws_s3_object" "microvm_source" {
  count = var.enable_microvm ? 1 : 0

  bucket      = aws_s3_bucket.microvm_source.id
  key         = local.microvm_source_object_key
  source      = local.microvm_source_zip_path
  source_hash = local.microvm_source_sha256 == "missing" ? null : local.microvm_source_sha256

  server_side_encryption = "aws:kms"
  kms_key_id             = aws_kms_key.data.arn
  content_type           = "application/zip"

  tags = local.tags

  lifecycle {
    precondition {
      condition     = fileexists(local.microvm_source_zip_path)
      error_message = "The MicroVM source ZIP does not exist. Run npm run package before enabling MicroVM infrastructure."
    }

    precondition {
      condition     = can(regex("^microvm/source-[0-9a-f]{64}\\.zip$", local.microvm_source_object_key))
      error_message = "The MicroVM source object key must use a path-safe hexadecimal SHA-256 digest."
    }
  }

  depends_on = [aws_s3_bucket_server_side_encryption_configuration.microvm_source]
}

resource "awscc_lambda_microvm_image" "runner" {
  count = var.enable_microvm ? 1 : 0

  name        = "${local.name}-agent"
  description = "ARM64 isolated execution image for ${local.name} agent runs"

  base_image_arn     = local.microvm_base_image_arn
  base_image_version = coalesce(var.microvm_base_image_version, "UNPROVISIONED")
  build_role_arn     = aws_iam_role.microvm_build.arn
  code_artifact = {
    uri = "s3://${aws_s3_bucket.microvm_source.id}/${aws_s3_object.microvm_source[0].key}"
  }

  # The AWSCC Cloud Control schema currently marks this property as required
  # and drops an empty set before sending the create model. AWS currently
  # supports only ALL; capabilities remain inside the MicroVM boundary, while
  # the agent subprocess still runs as the unprivileged UID/GID 10001.
  additional_os_capabilities = ["ALL"]
  cpu_configurations = [{
    architecture = "ARM_64"
  }]
  egress_network_connectors = [local.microvm_build_egress_connector_arn]
  environment_variables = concat([
    {
      key   = "ALLOWED_SANDBOX_MODES"
      value = join(",", var.allowed_sandbox_modes)
    },
    {
      key   = "DEFAULT_SANDBOX_MODE"
      value = var.default_sandbox_mode
    },
    {
      key   = "DEFAULT_AGENT_NETWORK_ACCESS"
      value = tostring(var.default_agent_network_access)
    },
    {
      key   = "CODEX_AUTH_MODE"
      value = "bedrock"
    },
    {
      key   = "ALLOW_AGENT_AWS_CREDENTIAL_CHAIN"
      value = tostring(var.allow_agent_aws_credential_chain)
    },
    {
      key   = "RUN_AGENT_GID"
      value = "10001"
    },
    {
      key   = "RUN_AGENT_UID"
      value = "10001"
    },
    ], length(var.integration_plugin_base_urls) > 0 ? [
    {
      key   = "INTEGRATION_PLUGIN_BASE_URLS"
      value = jsonencode(var.integration_plugin_base_urls)
    },
    ] : [], length(var.integration_oauth_app_secret_arns) > 0 ? [
    {
      # Only secret ARNs cross the image boundary. The worker role already has
      # narrowly scoped GetSecretValue access and the runner resolves the
      # OAuth application immediately before a fenced token refresh.
      key   = "INTEGRATION_OAUTH_APP_SECRET_ARNS"
      value = jsonencode(var.integration_oauth_app_secret_arns)
    },
    ] : [], local.publication_delivery_enabled ? [
    {
      key   = "AGENT_PUBLICATION_ENABLED"
      value = "true"
    },
    {
      key   = "PUBLICATION_BASE_DOMAIN"
      value = local.publication_domain
    },
    {
      key   = "ARTIFACT_URL_TTL_SECONDS"
      value = tostring(var.artifact_url_ttl_seconds)
    },
  ] : [])
  resources = [{
    minimum_memory_in_mi_b = var.microvm_memory_mib
  }]

  hooks = {
    port = 8080
    microvm_image_hooks = {
      ready                       = "ENABLED"
      ready_timeout_in_seconds    = 300
      validate                    = "ENABLED"
      validate_timeout_in_seconds = 300
    }
    microvm_hooks = {
      run                          = "ENABLED"
      run_timeout_in_seconds       = 60
      resume                       = "ENABLED"
      resume_timeout_in_seconds    = 60
      suspend                      = "ENABLED"
      suspend_timeout_in_seconds   = 60
      terminate                    = "ENABLED"
      terminate_timeout_in_seconds = 60
    }
  }

  logging = {
    cloudwatch = {
      log_group = aws_cloudwatch_log_group.microvm.name
    }
  }

  tags = local.microvm_tags

  depends_on = [
    aws_iam_role_policy.microvm_build,
    aws_iam_role_policy.microvm_self_terminate,
    aws_s3_object.microvm_source,
  ]
}

# The Cloud Control resource can retain the pre-update computed version in the
# same apply that builds a new image. Re-read it after the asynchronous update
# finishes so consumers are pinned to the version that was actually activated.
data "awscc_lambda_microvm_image" "runner" {
  count = var.enable_microvm ? 1 : 0

  id = awscc_lambda_microvm_image.runner[0].image_arn

  depends_on = [awscc_lambda_microvm_image.runner]
}

resource "aws_ssm_parameter" "microvm_image" {
  name        = "/${local.name}/microvm/image-arn"
  description = "Active Lambda MicroVM image ARN, or UNPROVISIONED when the preview backend is disabled"
  type        = "String"
  value       = var.enable_microvm ? awscc_lambda_microvm_image.runner[0].image_arn : "UNPROVISIONED"
  tags        = local.tags
}

resource "aws_ssm_parameter" "microvm_image_version" {
  name        = "/${local.name}/microvm/image-version"
  description = "Pinned active Lambda MicroVM image version, or UNPROVISIONED when disabled"
  type        = "String"
  value       = var.enable_microvm ? data.awscc_lambda_microvm_image.runner[0].latest_active_image_version : "UNPROVISIONED"
  tags        = local.tags
}
