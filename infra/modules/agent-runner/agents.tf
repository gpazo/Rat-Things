resource "aws_dynamodb_table" "agents" {
  name             = "${local.name}-agents"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "scope"
  range_key        = "key"
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  attribute {
    name = "scope"
    type = "S"
  }

  attribute {
    name = "key"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  tags = merge(local.tags, { Name = "${local.name}-agents" })
}

resource "aws_lambda_event_source_mapping" "agents_outbox" {
  event_source_arn                   = aws_dynamodb_table.agents.stream_arn
  function_name                      = aws_lambda_function.this["agents-outbox"].arn
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]
  filter_criteria {
    filter {
      pattern = jsonencode({ dynamodb = { NewImage = { collection = { S = ["sessions", "environments", "session_runtime", "session_integrations", "schedules", "session_event_batches", "webhook_deliveries"] }, key = { S = ["root"] } } } })
    }
  }
  depends_on = [aws_iam_role_policy.agents_outbox]
}

resource "aws_lambda_function_url" "agents" {
  function_name      = aws_lambda_function.this["agents-api"].function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "RESPONSE_STREAM"
}

resource "aws_sqs_queue" "agents_failures" {
  name                      = "${local.name}-agents-failures.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn
  tags                      = local.tags
}

resource "aws_sqs_queue" "agents" {
  name                       = "${local.name}-agents.fifo"
  fifo_queue                 = true
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 360
  kms_master_key_id          = aws_kms_key.data.arn
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.agents_failures.arn, maxReceiveCount = 1000 })
  tags                       = local.tags
}

resource "aws_lambda_event_source_mapping" "agents_queue" {
  event_source_arn        = aws_sqs_queue.agents.arn
  function_name           = aws_lambda_function.this["agents-outbox"].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  depends_on              = [aws_iam_role_policy.agents_outbox]
}

resource "aws_lambda_event_source_mapping" "agents_completion" {
  event_source_arn                   = aws_dynamodb_table.runs.stream_arn
  function_name                      = aws_lambda_function.this["agents-outbox"].arn
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]
  filter_criteria {
    filter {
      pattern = jsonencode({ dynamodb = { NewImage = { status = { S = ["succeeded", "failed", "cancelled"] }, agentsSession = { M = { sessionId = { S = [{ exists = true }] } } } } } })
    }
  }
  depends_on = [aws_iam_role_policy.agents_outbox]
}
