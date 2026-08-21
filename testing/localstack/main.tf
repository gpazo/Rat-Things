locals {
  name = "rat-things-test"
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "${local.name}-artifacts"
  force_destroy = true
}

resource "aws_s3_bucket" "definitions" {
  bucket        = "${local.name}-definitions"
  force_destroy = true
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

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"
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
}

resource "aws_sqs_queue" "run_dlq" {
  name                      = "${local.name}-runs-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "runs" {
  name                       = "${local.name}-runs"
  visibility_timeout_seconds = 180
  message_retention_seconds  = 86400
  receive_wait_time_seconds  = 1

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.run_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue" "conversation_dlq" {
  name                      = "${local.name}-conversations-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "conversations" {
  name                       = "${local.name}-conversations"
  visibility_timeout_seconds = 180
  message_retention_seconds  = 86400
  receive_wait_time_seconds  = 1

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.conversation_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue" "terminal_events" {
  name                       = "${local.name}-terminal-events"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 86400
  receive_wait_time_seconds  = 1
}

resource "aws_cloudwatch_event_bus" "runs" {
  name = "${local.name}-runs"
}

resource "aws_cloudwatch_event_rule" "terminal_runs" {
  name           = "${local.name}-terminal-runs"
  event_bus_name = aws_cloudwatch_event_bus.runs.name
  event_pattern = jsonencode({
    source      = ["rat-things.agent-runtime"]
    detail-type = ["Agent Run State"]
    detail = {
      status = ["succeeded", "failed", "cancelled"]
    }
  })
}

data "aws_iam_policy_document" "terminal_events" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.terminal_events.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_sqs_queue_policy" "terminal_events" {
  queue_url = aws_sqs_queue.terminal_events.url
  policy    = data.aws_iam_policy_document.terminal_events.json
}

resource "aws_cloudwatch_event_target" "terminal_events" {
  rule           = aws_cloudwatch_event_rule.terminal_runs.name
  event_bus_name = aws_cloudwatch_event_bus.runs.name
  target_id      = "terminal-event-capture"
  arn            = aws_sqs_queue.terminal_events.arn

  depends_on = [aws_sqs_queue_policy.terminal_events]
}
