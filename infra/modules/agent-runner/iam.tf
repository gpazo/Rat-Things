data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "microvm_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ingress" {
  name               = "${local.name}-lambda-ingress"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "control" {
  name               = "${local.name}-lambda-control"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "conversation_coordinator" {
  name               = "${local.name}-lambda-conversation-coordinator"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "conversation_completion" {
  name               = "${local.name}-lambda-conversation-completion"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "dispatcher" {
  name               = "${local.name}-lambda-dispatcher"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "notifier" {
  name               = "${local.name}-lambda-notifier"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "state_stream" {
  name               = "${local.name}-lambda-state-stream"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "reconciler" {
  name               = "${local.name}-lambda-reconciler"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "microvm_execution" {
  name               = "${local.name}-microvm-execution"
  assume_role_policy = data.aws_iam_policy_document.microvm_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "microvm_build" {
  name               = "${local.name}-microvm-build"
  assume_role_policy = data.aws_iam_policy_document.microvm_assume.json
  tags               = local.tags
}

locals {
  data_kms_actions = [
    "kms:Decrypt",
    "kms:DescribeKey",
    "kms:Encrypt",
    "kms:GenerateDataKey",
  ]
  run_table_read_write_actions = [
    "dynamodb:DeleteItem",
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Query",
    "dynamodb:UpdateItem",
  ]
  conversation_table_append_actions = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:TransactWriteItems",
    "dynamodb:UpdateItem",
  ]
  conversation_table_coordinator_actions = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Query",
    "dynamodb:TransactWriteItems",
    "dynamodb:UpdateItem",
  ]
  integration_table_read_actions = [
    "dynamodb:GetItem",
    "dynamodb:Query",
  ]
  integration_table_read_write_actions = concat(local.integration_table_read_actions, [
    "dynamodb:PutItem",
    "dynamodb:TransactWriteItems",
    "dynamodb:UpdateItem",
  ])
  integration_credential_secret_arn = "arn:${data.aws_partition.current.partition}:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:${local.name}/connections/*"
}

data "aws_iam_policy_document" "ingress" {
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.name}-webhook-*:*"]
  }

  statement {
    sid       = "Runs"
    actions   = local.run_table_read_write_actions
    resources = [aws_dynamodb_table.runs.arn, "${aws_dynamodb_table.runs.arn}/index/*"]
  }

  statement {
    sid       = "Conversations"
    actions   = local.conversation_table_append_actions
    resources = [aws_dynamodb_table.conversations.arn]
  }

  statement {
    sid       = "SourcePolicies"
    actions   = local.integration_table_read_actions
    resources = [aws_dynamodb_table.integrations.arn]
  }

  statement {
    sid       = "Inputs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  statement {
    sid       = "Queue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runs.arn, aws_sqs_queue.conversations.arn]
  }

  statement {
    sid       = "DataKey"
    actions   = local.data_kms_actions
    resources = [aws_kms_key.data.arn]
  }

  dynamic "statement" {
    for_each = length(local.ingress_secret_arns) > 0 ? [1] : []
    content {
      sid       = "WebhookSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.ingress_secret_arns
    }
  }
}

resource "aws_iam_role_policy" "ingress" {
  name   = "ingress"
  role   = aws_iam_role.ingress.id
  policy = data.aws_iam_policy_document.ingress.json
}

data "aws_iam_policy_document" "control" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["control"].arn}:*"]
  }

  statement {
    sid       = "Runs"
    actions   = local.run_table_read_write_actions
    resources = [aws_dynamodb_table.runs.arn, "${aws_dynamodb_table.runs.arn}/index/*"]
  }

  statement {
    sid       = "Conversations"
    actions   = local.conversation_table_coordinator_actions
    resources = [aws_dynamodb_table.conversations.arn, "${aws_dynamodb_table.conversations.arn}/index/*"]
  }

  statement {
    sid       = "Integrations"
    actions   = local.integration_table_read_write_actions
    resources = [aws_dynamodb_table.integrations.arn]
  }

  statement {
    sid       = "Routines"
    actions   = local.run_table_read_write_actions
    resources = [aws_dynamodb_table.routines.arn, "${aws_dynamodb_table.routines.arn}/index/*"]
  }

  statement {
    sid = "IntegrationCredentials"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
    ]
    resources = [local.integration_credential_secret_arn]
  }

  statement {
    sid       = "Artifacts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  dynamic "statement" {
    for_each = local.publication_delivery_enabled ? [1] : []
    content {
      sid       = "PublicationSigningKey"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [var.publication_private_key_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = local.publication_delivery_enabled && var.publication_private_key_kms_key_arn != null ? [1] : []
    content {
      sid       = "PublicationSigningKeyDecrypt"
      actions   = ["kms:Decrypt"]
      resources = [var.publication_private_key_kms_key_arn]
    }
  }

  statement {
    sid       = "Queue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runs.arn, aws_sqs_queue.conversations.arn]
  }

  dynamic "statement" {
    for_each = var.enable_microvm ? [1] : []
    content {
      sid = "MicrovmControl"
      actions = [
        "lambda:CreateMicrovmAuthToken",
        "lambda:GetMicrovm",
        "lambda:TerminateMicrovm",
      ]
      resources = ["*"]
    }
  }

  statement {
    sid       = "DataKey"
    actions   = local.data_kms_actions
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "control" {
  name   = "control"
  role   = aws_iam_role.control.id
  policy = data.aws_iam_policy_document.control.json
}

data "aws_iam_policy_document" "dispatcher" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["dispatcher"].arn}:*"]
  }

  statement {
    sid       = "QueueConsumer"
    actions   = ["sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
    resources = [aws_sqs_queue.runs.arn]
  }

  statement {
    sid       = "Runs"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.runs.arn]
  }

  statement {
    sid       = "Conversations"
    actions   = local.conversation_table_coordinator_actions
    resources = [aws_dynamodb_table.conversations.arn, "${aws_dynamodb_table.conversations.arn}/index/*"]
  }

  statement {
    sid       = "Artifacts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  dynamic "statement" {
    for_each = var.enable_microvm ? [1] : []
    content {
      sid = "MicrovmLifecycle"
      actions = [
        "lambda:CreateMicrovmAuthToken",
        "lambda:GetMicrovm",
        "lambda:ResumeMicrovm",
        "lambda:RunMicrovm",
        "lambda:TerminateMicrovm",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_microvm ? [1] : []
    content {
      sid     = "PassManagedNetworkConnectors"
      actions = ["lambda:PassNetworkConnector"]
      # AWS currently defines no resource type or condition key for this
      # permission-only action, so IAM requires Resource="*" even when the
      # service-selected connectors are AWS-managed defaults.
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_microvm ? [1] : []
    content {
      sid       = "ReadMicrovmConfiguration"
      actions   = ["ssm:GetParameter"]
      resources = ["arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${local.name}/microvm/*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_microvm ? [1] : []
    content {
      sid       = "PassMicrovmExecutionRole"
      actions   = ["iam:PassRole"]
      resources = [aws_iam_role.microvm_execution.arn]
    }
  }

  statement {
    sid       = "DataKey"
    actions   = local.data_kms_actions
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "dispatcher" {
  name   = "dispatcher"
  role   = aws_iam_role.dispatcher.id
  policy = data.aws_iam_policy_document.dispatcher.json
}

data "aws_iam_policy_document" "conversation_coordinator" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["conversation-coordinator"].arn}:*"]
  }

  statement {
    sid       = "ConversationQueueConsumer"
    actions   = ["sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
    resources = [aws_sqs_queue.conversations.arn]
  }

  statement {
    sid       = "RunQueueProducer"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runs.arn]
  }

  statement {
    sid       = "Runs"
    actions   = local.run_table_read_write_actions
    resources = [aws_dynamodb_table.runs.arn, "${aws_dynamodb_table.runs.arn}/index/*"]
  }

  statement {
    sid       = "Conversations"
    actions   = local.conversation_table_coordinator_actions
    resources = [aws_dynamodb_table.conversations.arn, "${aws_dynamodb_table.conversations.arn}/index/*"]
  }

  statement {
    sid       = "Artifacts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  statement {
    sid       = "DataKey"
    actions   = local.data_kms_actions
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "conversation_coordinator" {
  name   = "conversation-coordinator"
  role   = aws_iam_role.conversation_coordinator.id
  policy = data.aws_iam_policy_document.conversation_coordinator.json
}

data "aws_iam_policy_document" "conversation_completion" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["conversation-completion"].arn}:*"]
  }

  statement {
    sid       = "Runs"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.runs.arn]
  }

  statement {
    sid       = "Conversations"
    actions   = local.conversation_table_coordinator_actions
    resources = [aws_dynamodb_table.conversations.arn, "${aws_dynamodb_table.conversations.arn}/index/*"]
  }

  statement {
    sid       = "Artifacts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  statement {
    sid       = "ConversationQueueProducer"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.conversations.arn]
  }

  dynamic "statement" {
    for_each = var.enable_microvm ? [1] : []
    content {
      sid       = "SuspendConversationMicrovm"
      actions   = ["lambda:SuspendMicrovm"]
      resources = ["*"]
    }
  }

  statement {
    sid       = "DataKey"
    actions   = local.data_kms_actions
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "conversation_completion" {
  name   = "conversation-completion"
  role   = aws_iam_role.conversation_completion.id
  policy = data.aws_iam_policy_document.conversation_completion.json
}

data "aws_iam_policy_document" "notifier" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["notifier"].arn}:*"]
  }

  statement {
    sid       = "RunsAndDeliveryFence"
    actions   = local.run_table_read_write_actions
    resources = [aws_dynamodb_table.runs.arn]
  }

  statement {
    sid       = "Artifacts"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  statement {
    sid       = "DataKey"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.data.arn]
  }

  dynamic "statement" {
    for_each = length(local.notifier_secret_arns) > 0 ? [1] : []
    content {
      sid       = "DeliverySecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.notifier_secret_arns
    }
  }
}

resource "aws_iam_role_policy" "notifier" {
  name   = "notifier"
  role   = aws_iam_role.notifier.id
  policy = data.aws_iam_policy_document.notifier.json
}

data "aws_iam_policy_document" "state_stream" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["state-stream"].arn}:*"]
  }

  statement {
    sid = "ReadRunStream"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ]
    resources = [aws_dynamodb_table.runs.stream_arn]
  }

  statement {
    sid       = "ListRunStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }

  statement {
    sid       = "PublishRunState"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.runs.arn]
  }

  statement {
    sid       = "RetainDiscardedStreamInvocations"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.state_stream_failures.arn]
  }

  statement {
    sid       = "FailureQueueDataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "state_stream" {
  name   = "state-stream"
  role   = aws_iam_role.state_stream.id
  policy = data.aws_iam_policy_document.state_stream.json
}

data "aws_iam_policy_document" "reconciler" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["reconciler"].arn}:*"]
  }

  statement {
    sid       = "QueryStaleQueuedRuns"
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.runs.arn}/index/status-updated-index"]
  }

  statement {
    sid       = "FinalizeUnlaunchedCancellations"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.runs.arn]
  }

  statement {
    sid = "Routines"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.routines.arn, "${aws_dynamodb_table.routines.arn}/index/*"]
  }

  statement {
    sid       = "RoutineRuns"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.runs.arn]
  }

  statement {
    sid       = "RoutineArtifacts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  statement {
    sid       = "RenudgeQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runs.arn]
  }

  statement {
    sid       = "QueueDataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "reconciler" {
  name   = "reconciler"
  role   = aws_iam_role.reconciler.id
  policy = data.aws_iam_policy_document.reconciler.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "RunState"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.runs.arn]
  }

  statement {
    sid       = "Integrations"
    actions   = local.integration_table_read_actions
    resources = [aws_dynamodb_table.integrations.arn]
  }

  statement {
    sid       = "IntegrationCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.integration_credential_secret_arn]
  }

  statement {
    sid       = "ArtifactBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["owners/*"]
    }
  }

  statement {
    sid       = "RunArtifacts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  statement {
    sid       = "DataKey"
    actions   = local.data_kms_actions
    resources = [aws_kms_key.data.arn]
  }

  dynamic "statement" {
    for_each = var.enable_s3_files ? [1] : []
    content {
      sid       = "ConversationStateFileSystem"
      actions   = ["s3files:ClientMount", "s3files:ClientWrite"]
      resources = [aws_s3files_file_system.conversation_state[0].arn]

      condition {
        test     = "StringEquals"
        variable = "s3files:AccessPointArn"
        values   = [aws_s3files_access_point.conversation_state[0].arn]
      }
    }
  }

  dynamic "statement" {
    for_each = var.enable_s3_files ? [1] : []
    content {
      sid       = "ConversationStateBucket"
      actions   = ["s3:ListBucket"]
      resources = [aws_s3_bucket.conversation_state[0].arn]
    }
  }

  dynamic "statement" {
    for_each = var.enable_s3_files ? [1] : []
    content {
      sid       = "ConversationStateObjects"
      actions   = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = ["${aws_s3_bucket.conversation_state[0].arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = length(local.worker_secret_arns) > 0 ? [1] : []
    content {
      sid       = "WorkerSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.worker_secret_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.codex_bedrock_model_ids) > 0 ? [1] : []
    content {
      sid       = "BedrockMantleShortTermToken"
      actions   = ["bedrock-mantle:CallWithBearerToken"]
      resources = ["*"]
      condition {
        test     = "StringEquals"
        variable = "bedrock-mantle:BearerTokenType"
        values   = ["SHORT_TERM"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.codex_bedrock_model_ids) > 0 ? [1] : []
    content {
      sid = "CodexInference"
      actions = [
        "bedrock-mantle:CancelInference",
        "bedrock-mantle:CreateInference",
        "bedrock-mantle:GetInference",
      ]
      resources = ["arn:${data.aws_partition.current.partition}:bedrock-mantle:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:project/*"]
      condition {
        test     = "StringEqualsIfExists"
        variable = "bedrock-mantle:Model"
        values   = var.codex_bedrock_model_ids
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.codex_bedrock_model_ids) > 0 ? [1] : []
    content {
      sid = "CodexModelDiscovery"
      actions = [
        "bedrock-mantle:GetProject",
        "bedrock-mantle:GetModel",
        "bedrock-mantle:ListModels",
        "bedrock-mantle:ListProjects",
      ]
      resources = ["arn:${data.aws_partition.current.partition}:bedrock-mantle:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:project/*"]
    }
  }

  dynamic "statement" {
    for_each = length(var.codex_bedrock_model_ids) > 0 ? [1] : []
    content {
      sid = "CodexMarketplaceAccess"
      actions = [
        "aws-marketplace:Subscribe",
        "aws-marketplace:ViewSubscriptions",
      ]
      resources = ["*"]
      condition {
        test     = "StringEquals"
        variable = "aws:CalledViaLast"
        values   = ["bedrock-mantle.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "microvm_execution" {
  name   = "worker"
  role   = aws_iam_role.microvm_execution.id
  policy = data.aws_iam_policy_document.worker.json
}

data "aws_iam_policy_document" "microvm_execution_logs" {
  statement {
    actions = ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]
    resources = [
      aws_cloudwatch_log_group.microvm.arn,
      "${aws_cloudwatch_log_group.microvm.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "microvm_execution_logs" {
  name   = "logs"
  role   = aws_iam_role.microvm_execution.id
  policy = data.aws_iam_policy_document.microvm_execution_logs.json
}

data "aws_iam_policy_document" "microvm_self_terminate" {
  count = var.enable_microvm ? 1 : 0

  statement {
    sid       = "SelfTerminate"
    actions   = ["lambda:TerminateMicrovm"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "microvm_self_terminate" {
  count = var.enable_microvm ? 1 : 0

  name   = "self-terminate"
  role   = aws_iam_role.microvm_execution.id
  policy = data.aws_iam_policy_document.microvm_self_terminate[0].json
}

data "aws_iam_policy_document" "microvm_build" {
  statement {
    sid       = "ReadSourceBucketMetadata"
    actions   = ["s3:GetBucketLocation"]
    resources = [aws_s3_bucket.microvm_source.arn]
  }

  statement {
    sid       = "ListSourcePrefix"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.microvm_source.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["microvm/*"]
    }
  }

  statement {
    sid       = "ReadSourceBucket"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.microvm_source.arn}/microvm/*"]
  }

  statement {
    sid       = "DecryptSource"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.data.arn]
  }

  statement {
    sid = "BuildLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/microvms/*",
      aws_cloudwatch_log_group.microvm.arn,
      "${aws_cloudwatch_log_group.microvm.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "microvm_build" {
  name   = "build"
  role   = aws_iam_role.microvm_build.id
  policy = data.aws_iam_policy_document.microvm_build.json
}
