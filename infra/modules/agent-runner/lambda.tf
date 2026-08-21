locals {
  lambda_common_environment = {
    ALLOWED_REPOSITORY_HOSTS            = join(",", var.allowed_repository_hosts)
    ALLOWED_SANDBOX_MODES               = join(",", var.allowed_sandbox_modes)
    DEFAULT_SANDBOX_MODE                = var.default_sandbox_mode
    DEFAULT_AGENT_NETWORK_ACCESS        = tostring(var.default_agent_network_access)
    ARTIFACT_BUCKET                     = aws_s3_bucket.artifacts.id
    DEFINITION_BUCKET                   = aws_s3_bucket.definitions.id
    DEFINITION_KMS_KEY_ARN              = aws_kms_key.data.arn
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    CONVERSATIONS_TABLE_NAME            = aws_dynamodb_table.conversations.name
    INTEGRATIONS_TABLE_NAME             = aws_dynamodb_table.integrations.name
    ROUTINES_TABLE_NAME                 = aws_dynamodb_table.routines.name
    THINGS_TABLE_NAME                   = aws_dynamodb_table.things.name
    INTEGRATION_CREDENTIAL_NAME_PREFIX  = "${local.name}/connections"
    INTEGRATION_CREDENTIAL_KMS_KEY_ARN  = aws_kms_key.data.arn
    CONVERSATION_QUEUE_URL              = aws_sqs_queue.conversations.url
    METRIC_DEPLOYMENT                   = local.name
    METRIC_NAMESPACE                    = "RatThings"
    RUNS_TABLE_NAME                     = aws_dynamodb_table.runs.name
    RUN_QUEUE_URL                       = aws_sqs_queue.runs.url
    RUN_RETENTION_SECONDS               = tostring(var.run_retention_seconds)
  }

  executor_environment = merge(local.lambda_common_environment, {
    ALLOW_AGENT_AWS_CREDENTIAL_CHAIN     = tostring(var.allow_agent_aws_credential_chain)
    DEFAULT_AGENT_DRIVER                 = var.default_agent_driver
    DEFAULT_EXECUTION_BACKEND            = "microvm"
    EVENT_BUS_NAME                       = aws_cloudwatch_event_bus.runs.name
    MICROVM_EXECUTION_ROLE_ARN           = aws_iam_role.microvm_execution.arn
    MICROVM_IMAGE_PARAMETER_NAME         = aws_ssm_parameter.microvm_image.name
    MICROVM_IMAGE_VERSION_PARAMETER_NAME = aws_ssm_parameter.microvm_image_version.name
    MICROVM_LOG_GROUP_NAME               = aws_cloudwatch_log_group.microvm.name
    MICROVM_SESSION_IDLE_SECONDS         = tostring(var.microvm_session_idle_seconds)
    MICROVM_SESSION_SUSPENDED_SECONDS    = tostring(var.microvm_session_suspended_seconds)
    S3_FILES_ENABLED                     = tostring(var.enable_s3_files)
    }, length(var.codex_bedrock_model_ids) > 0 ? {
    # Keep the unattended runtime default inside the same exact-model IAM
    # allowlist. Callers may still select another explicitly allowed model.
    DEFAULT_MODEL = var.codex_bedrock_model_ids[0]
    } : {}, local.bedrock_api_key_secret_arn == null ? {} : {
    BEDROCK_API_KEY_SECRET_ARN = local.bedrock_api_key_secret_arn
    }, var.enable_s3_files ? {
    MICROVM_VPC_NETWORK_CONNECTOR_ARN = awscc_lambda_network_connector.s3_files[0].arn
    S3_FILES_ACCESS_POINT_ID          = aws_s3files_access_point.conversation_state[0].id
    S3_FILES_FILE_SYSTEM_ID           = aws_s3files_file_system.conversation_state[0].id
    S3_FILES_MOUNT_TARGET_IP          = aws_s3files_mount_target.conversation_state[0].ipv4_address
  } : {})

  lambda_definitions = {
    control = {
      enabled  = true
      zip_path = local.lambda_zip_paths.control
      role_arn = aws_iam_role.control.arn
      timeout  = 30
      memory   = 512
      environment = merge(
        local.executor_environment,
        {
          ALLOW_OWNER_HEADER       = "false"
          ARTIFACT_URL_TTL_SECONDS = tostring(var.artifact_url_ttl_seconds)
        },
        local.publication_delivery_enabled ? {
          PUBLICATION_BASE_DOMAIN            = local.publication_domain
          PUBLICATION_KEY_PAIR_ID            = aws_cloudfront_public_key.publications[0].id
          PUBLICATION_PRIVATE_KEY_SECRET_ARN = var.publication_private_key_secret_arn
        } : {},
      )
    }
    conversation-coordinator = {
      enabled  = true
      zip_path = local.lambda_zip_paths["conversation-coordinator"]
      role_arn = aws_iam_role.conversation_coordinator.arn
      timeout  = 60
      memory   = 512
      environment = merge(local.lambda_common_environment, {
        CONVERSATION_SLICE_TIMEOUT_SECONDS = tostring(var.conversation_slice_timeout_seconds)
      })
    }
    conversation-completion = {
      enabled     = true
      zip_path    = local.lambda_zip_paths["conversation-completion"]
      role_arn    = aws_iam_role.conversation_completion.arn
      timeout     = 60
      memory      = 512
      environment = local.lambda_common_environment
    }
    dispatcher = {
      enabled     = true
      zip_path    = local.lambda_zip_paths.dispatcher
      role_arn    = aws_iam_role.dispatcher.arn
      timeout     = 60
      memory      = 512
      environment = local.executor_environment
    }
    notifier = {
      enabled  = true
      zip_path = local.lambda_zip_paths.notifier
      role_arn = aws_iam_role.notifier.arn
      timeout  = 30
      memory   = 512
      environment = merge(local.lambda_common_environment, {
        DEFAULT_DELIVERY_DESTINATIONS = var.default_delivery_destinations
        GITHUB_API_BASE_URL           = var.github_api_base_url
        GITLAB_API_BASE_URL           = var.gitlab_api_base_url
        TEAMS_DELIVERY_MODE           = var.teams_delivery_mode
        }, local.github_notify_token_secret_arn == null ? {} : {
        GITHUB_NOTIFY_TOKEN_SECRET_ARN = local.github_notify_token_secret_arn
        }, local.gitlab_notify_token_secret_arn == null ? {} : {
        GITLAB_NOTIFY_TOKEN_SECRET_ARN = local.gitlab_notify_token_secret_arn
        }, var.teams_workflow_url_secret_arn == null ? {} : {
        TEAMS_WORKFLOW_URL_SECRET_ARN = var.teams_workflow_url_secret_arn
        }, var.teams_reply_gateway_url_secret_arn == null ? {} : {
        TEAMS_REPLY_GATEWAY_URL_SECRET_ARN = var.teams_reply_gateway_url_secret_arn
        }, length(var.teams_route_secret_arns) == 0 ? {} : {
        TEAMS_ROUTES_JSON = jsonencode(var.teams_route_secret_arns)
        }, var.slack_bot_token_secret_arn == null ? {} : {
        SLACK_BOT_TOKEN_SECRET_ARN = var.slack_bot_token_secret_arn
      })
    }
    reconciler = {
      enabled  = true
      zip_path = local.lambda_zip_paths.reconciler
      role_arn = aws_iam_role.reconciler.arn
      timeout  = 30
      memory   = 256
      environment = merge(local.lambda_common_environment, {
        ROUTINE_TICK_LIMIT = "100"
      })
    }
    state-stream = {
      enabled  = true
      zip_path = local.lambda_zip_paths["state-stream"]
      role_arn = aws_iam_role.state_stream.arn
      timeout  = 30
      memory   = 256
      environment = {
        AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
        EVENT_BUS_NAME                      = aws_cloudwatch_event_bus.runs.name
        EVENT_SOURCE                        = "rat-things.agent-runtime"
      }
    }
    webhook-github = {
      enabled  = local.github_enabled
      zip_path = local.lambda_zip_paths["webhook-github"]
      role_arn = aws_iam_role.ingress.arn
      timeout  = 10
      memory   = 256
      environment = merge(local.lambda_common_environment, {
        GITHUB_COMMENT_TRIGGER    = var.github_comment_trigger
        GITHUB_WEBHOOK_SECRET_ARN = coalesce(var.github_webhook_secret_arn, "DISABLED")
        }, local.github_clone_token_secret_arn == null ? {} : {
        GITHUB_CLONE_TOKEN_SECRET_ARN = local.github_clone_token_secret_arn
      })
    }
    webhook-gitlab = {
      enabled  = local.gitlab_enabled
      zip_path = local.lambda_zip_paths["webhook-gitlab"]
      role_arn = aws_iam_role.ingress.arn
      timeout  = 10
      memory   = 256
      environment = merge(local.lambda_common_environment, {
        GITLAB_COMMENT_TRIGGER    = var.gitlab_comment_trigger
        GITLAB_WEBHOOK_SECRET_ARN = coalesce(var.gitlab_webhook_secret_arn, "DISABLED")
        }, local.gitlab_clone_token_secret_arn == null ? {} : {
        GITLAB_CLONE_TOKEN_SECRET_ARN = local.gitlab_clone_token_secret_arn
      })
    }
    webhook-teams = {
      enabled  = local.teams_enabled
      zip_path = local.lambda_zip_paths["webhook-teams"]
      role_arn = aws_iam_role.ingress.arn
      timeout  = 5
      memory   = 256
      environment = merge(local.lambda_common_environment, {
        TEAMS_OUTGOING_WEBHOOK_SECRET_ARN = coalesce(var.teams_outgoing_webhook_secret_arn, "DISABLED")
      })
    }
    webhook-slack = {
      enabled  = local.slack_enabled
      zip_path = local.lambda_zip_paths["webhook-slack"]
      role_arn = aws_iam_role.ingress.arn
      timeout  = 5
      memory   = 256
      environment = merge(local.lambda_common_environment, {
        SLACK_SIGNING_SECRET_ARN = coalesce(var.slack_signing_secret_arn, "DISABLED")
      })
    }
  }

  enabled_lambda_definitions = {
    for name, definition in local.lambda_definitions : name => definition if definition.enabled
  }
}

resource "aws_lambda_function" "this" {
  for_each = local.enabled_lambda_definitions

  function_name    = "${local.name}-${each.key}"
  description      = "${local.name} ${each.key} control-plane function"
  role             = each.value.role_arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  filename         = each.value.zip_path
  source_code_hash = fileexists(each.value.zip_path) ? filebase64sha256(each.value.zip_path) : null
  timeout          = each.value.timeout
  memory_size      = each.value.memory

  environment {
    variables = each.value.environment
  }

  tags = merge(local.tags, { Component = each.key })

  lifecycle {
    precondition {
      condition     = fileexists(each.value.zip_path)
      error_message = "Lambda package ${each.value.zip_path} does not exist. Run npm run package before planning or applying Terraform."
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_event_source_mapping" "dispatcher" {
  event_source_arn        = aws_sqs_queue.runs.arn
  function_name           = aws_lambda_function.this["dispatcher"].arn
  enabled                 = true
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 10
  }

  depends_on = [aws_iam_role_policy.dispatcher]
}

resource "aws_lambda_event_source_mapping" "conversation_coordinator" {
  event_source_arn        = aws_sqs_queue.conversations.arn
  function_name           = aws_lambda_function.this["conversation-coordinator"].arn
  enabled                 = true
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 10
  }

  depends_on = [aws_iam_role_policy.conversation_coordinator]
}

resource "aws_lambda_event_source_mapping" "state_stream" {
  event_source_arn = aws_dynamodb_table.runs.stream_arn
  function_name    = aws_lambda_function.this["state-stream"].arn
  enabled          = true
  # A freshly created mapping can become visible before its stream poller is
  # fully active. TRIM_HORIZON prevents runs submitted immediately after apply
  # from falling into that startup gap; the table is dedicated to this stack
  # and DynamoDB Streams retains only the bounded 24-hour window.
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1
  maximum_record_age_in_seconds      = 86400
  maximum_retry_attempts             = 10
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.state_stream_failures.arn
    }
  }

  depends_on = [aws_iam_role_policy.state_stream]
}
