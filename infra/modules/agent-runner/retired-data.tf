# Retained data from the retired Thing, Routine and conversation APIs.
# These resource addresses and physical names remain unchanged to avoid implicit
# deletion during the Agents API cutover. No application role can access them.
# Existing TTLs and SQS retention still apply. Export/retention/disposition must
# be decided before removing these definitions or purging deployed resources.

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

  attribute {
    name = "ownerId"
    type = "S"
  }

  attribute {
    name = "ownerCreated"
    type = "S"
  }

  global_secondary_index {
    name            = "conversation-work-index"
    projection_type = "ALL"

    key_schema {
      attribute_name = "workPartition"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "workOrder"
      key_type       = "RANGE"
    }
  }

  global_secondary_index {
    name            = "status-updated-index"
    projection_type = "ALL"

    key_schema {
      attribute_name = "status"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "updatedAt"
      key_type       = "RANGE"
    }
  }

  global_secondary_index {
    name            = "owner-created-index"
    projection_type = "ALL"

    key_schema {
      attribute_name = "ownerId"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "ownerCreated"
      key_type       = "RANGE"
    }
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
    projection_type = "ALL"

    key_schema {
      attribute_name = "ownerId"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "ownerCreated"
      key_type       = "RANGE"
    }
  }

  global_secondary_index {
    name            = "status-next-run-index"
    projection_type = "ALL"

    key_schema {
      attribute_name = "status"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "nextRunAt"
      key_type       = "RANGE"
    }
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

resource "aws_dynamodb_table" "things" {
  name         = "${local.name}-things"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "thingId"
  range_key    = "recordKey"

  attribute {
    name = "thingId"
    type = "S"
  }

  attribute {
    name = "recordKey"
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

  global_secondary_index {
    name            = "owner-created-index"
    projection_type = "ALL"

    key_schema {
      attribute_name = "ownerId"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "ownerCreated"
      key_type       = "RANGE"
    }
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  tags = merge(local.tags, { Name = "${local.name}-things" })
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

resource "aws_sqs_queue" "conversation_completion_failures" {
  name                      = "${local.name}-conversation-completion-failures"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = merge(local.tags, { Name = "${local.name}-conversation-completion-failures" })
}
