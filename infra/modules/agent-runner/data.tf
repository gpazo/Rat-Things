data "aws_iam_policy_document" "data_key" {
  statement {
    sid       = "EnableAccountKeyAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowEventBridgeEncryptedDeadLetterDelivery"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "${local.name} control-plane and agent-runner data"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.data_key.json

  tags = merge(local.tags, { Name = "${local.name}-data" })
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "${substr(local.name, 0, 35)}-artifacts-${local.bucket_suffix}"
  force_destroy = var.force_destroy_data

  tags = merge(local.tags, { Name = "${local.name}-artifacts" })
}

resource "aws_s3_bucket" "microvm_source" {
  bucket        = "${substr(local.name, 0, 35)}-mvm-src-${local.bucket_suffix}"
  force_destroy = var.force_destroy_data

  tags = merge(local.tags, { Name = "${local.name}-microvm-source" })
}

resource "aws_s3_bucket" "conversation_state" {
  count = var.enable_s3_files ? 1 : 0

  bucket        = "${substr(local.name, 0, 35)}-state-${local.bucket_suffix}"
  force_destroy = var.force_destroy_data

  tags = merge(local.tags, { Name = "${local.name}-conversation-state" })
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = merge({
    artifacts      = aws_s3_bucket.artifacts.id
    microvm_source = aws_s3_bucket.microvm_source.id
    }, var.enable_s3_files ? {
    conversation_state = aws_s3_bucket.conversation_state[0].id
  } : {})

  bucket = each.value

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = merge({
    artifacts      = aws_s3_bucket.artifacts.id
    microvm_source = aws_s3_bucket.microvm_source.id
    }, var.enable_s3_files ? {
    conversation_state = aws_s3_bucket.conversation_state[0].id
  } : {})

  bucket = each.value
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "microvm_source" {
  bucket = aws_s3_bucket.microvm_source.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.data.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "conversation_state" {
  count = var.enable_s3_files ? 1 : 0

  bucket = aws_s3_bucket.conversation_state[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "conversation_state" {
  count = var.enable_s3_files ? 1 : 0

  bucket = aws_s3_bucket.conversation_state[0].id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-run-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = var.artifact_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.artifact_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

data "aws_iam_policy_document" "bucket_transport" {
  for_each = merge({
    artifacts      = aws_s3_bucket.artifacts.arn
    microvm_source = aws_s3_bucket.microvm_source.arn
    }, var.enable_s3_files ? {
    conversation_state = aws_s3_bucket.conversation_state[0].arn
  } : {})

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      each.value,
      "${each.value}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "artifacts" && local.publication_delivery_enabled ? [1] : []
    content {
      sid     = "AllowCloudFrontPublications"
      effect  = "Allow"
      actions = ["s3:GetObject"]
      resources = [
        "${aws_s3_bucket.artifacts.arn}/owners/*/publications/*",
      ]
      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [aws_cloudfront_distribution.publications[0].arn]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = merge({
    artifacts = {
      id     = aws_s3_bucket.artifacts.id
      policy = data.aws_iam_policy_document.bucket_transport["artifacts"].json
    }
    microvm_source = {
      id     = aws_s3_bucket.microvm_source.id
      policy = data.aws_iam_policy_document.bucket_transport["microvm_source"].json
    }
    }, var.enable_s3_files ? {
    conversation_state = {
      id     = aws_s3_bucket.conversation_state[0].id
      policy = data.aws_iam_policy_document.bucket_transport["conversation_state"].json
    }
  } : {})

  bucket = each.value.id
  policy = each.value.policy
}

resource "aws_dynamodb_table" "runs" {
  name         = "${local.name}-runs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "runId"

  attribute {
    name = "runId"
    type = "S"
  }

  attribute {
    name = "ownerId"
    type = "S"
  }

  attribute {
    name = "ownerCreated"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "updatedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "owner-created-index"
    hash_key        = "ownerId"
    range_key       = "ownerCreated"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "status-updated-index"
    hash_key        = "status"
    range_key       = "updatedAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  tags = merge(local.tags, { Name = "${local.name}-runs" })
}

resource "aws_dynamodb_table" "conversations" {
  name         = "${local.name}-conversations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "workPartition"
    type = "S"
  }

  attribute {
    name = "workOrder"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "updatedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "conversation-work-index"
    hash_key        = "workPartition"
    range_key       = "workOrder"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "status-updated-index"
    hash_key        = "status"
    range_key       = "updatedAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  tags = merge(local.tags, { Name = "${local.name}-conversations" })
}

resource "aws_dynamodb_table" "integrations" {
  name         = "${local.name}-integrations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  tags = merge(local.tags, { Name = "${local.name}-integrations" })
}

resource "aws_dynamodb_table" "routines" {
  name         = "${local.name}-routines"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "routineId"

  attribute {
    name = "routineId"
    type = "S"
  }

  attribute {
    name = "ownerId"
    type = "S"
  }

  attribute {
    name = "ownerCreated"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "nextRunAt"
    type = "S"
  }

  global_secondary_index {
    name            = "owner-created-index"
    hash_key        = "ownerId"
    range_key       = "ownerCreated"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "status-next-run-index"
    hash_key        = "status"
    range_key       = "nextRunAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  tags = merge(local.tags, { Name = "${local.name}-routines" })
}

resource "aws_sqs_queue" "run_dlq" {
  name                      = "${local.name}-runs-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = merge(local.tags, { Name = "${local.name}-runs-dlq" })
}

resource "aws_sqs_queue" "runs" {
  name                       = "${local.name}-runs"
  visibility_timeout_seconds = 180
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.data.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.run_dlq.arn
    maxReceiveCount     = 5
  })

  tags = merge(local.tags, { Name = "${local.name}-runs" })
}

resource "aws_sqs_queue" "conversation_dlq" {
  name                      = "${local.name}-conversations-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = merge(local.tags, { Name = "${local.name}-conversations-dlq" })
}

resource "aws_sqs_queue" "conversations" {
  name                       = "${local.name}-conversations"
  visibility_timeout_seconds = 180
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.data.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.conversation_dlq.arn
    maxReceiveCount     = 5
  })

  tags = merge(local.tags, { Name = "${local.name}-conversations" })
}

resource "aws_sqs_queue" "state_stream_failures" {
  name                      = "${local.name}-state-stream-failures"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = merge(local.tags, { Name = "${local.name}-state-stream-failures" })
}

resource "aws_sqs_queue" "notifier_delivery_failures" {
  name                      = "${local.name}-notifier-delivery-failures"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = merge(local.tags, { Name = "${local.name}-notifier-delivery-failures" })
}

resource "aws_sqs_queue" "conversation_completion_failures" {
  name                      = "${local.name}-conversation-completion-failures"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = merge(local.tags, { Name = "${local.name}-conversation-completion-failures" })
}

resource "aws_cloudwatch_metric_alarm" "run_dlq" {
  alarm_name          = "${local.name}-runs-dlq"
  alarm_description   = "Run dispatch messages exhausted SQS receives and need operator investigation"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.run_dlq.name
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "conversation_dlq" {
  alarm_name          = "${local.name}-conversations-dlq"
  alarm_description   = "Conversation wake-ups exhausted SQS receives and need operator investigation"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.conversation_dlq.name
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "state_stream_failures" {
  alarm_name          = "${local.name}-state-stream-failures"
  alarm_description   = "DynamoDB run-state records exhausted Lambda retries and need replay"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.state_stream_failures.name
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "notifier_delivery_failures" {
  alarm_name          = "${local.name}-notifier-delivery-failures"
  alarm_description   = "Terminal run events exhausted EventBridge notifier delivery retries and need replay"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.notifier_delivery_failures.name
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "notifier_dlq_delivery_failures" {
  alarm_name          = "${local.name}-notifier-dlq-delivery-failures"
  alarm_description   = "EventBridge could not write an exhausted notifier invocation to its dead-letter queue"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "InvocationsFailedToBeSentToDLQ"
  namespace           = "AWS/Events"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    EventBusName = aws_cloudwatch_event_bus.runs.name
    RuleName     = aws_cloudwatch_event_rule.terminal_runs.name
  }

  tags = local.tags
}
