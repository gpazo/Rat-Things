# The public API and background dispatcher share Session persistence and runtime
# control. Provider delivery and schedule administration belong to the outbox.
data "aws_iam_policy_document" "agents_service" {
  statement {
    sid       = "AgentsResources"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.agents.arn]
  }
  statement {
    sid       = "SessionExecutions"
    actions   = local.run_table_read_write_actions
    resources = [aws_dynamodb_table.runs.arn, "${aws_dynamodb_table.runs.arn}/index/*"]
  }
  statement {
    sid       = "SessionObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*", "${aws_s3_bucket.definitions.arn}/owners/*"]
  }
  statement {
    sid       = "AgentsCredentials"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:DeleteSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:TagResource"]
    resources = ["arn:${data.aws_partition.current.partition}:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:${local.name}/connections/agents/*"]
  }
  statement {
    sid       = "DispatchExecutions"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runs.arn]
  }
  statement {
    sid       = "DataKey"
    actions   = local.data_kms_actions
    resources = [aws_kms_key.data.arn]
  }
  dynamic "statement" {
    for_each = var.enable_microvm ? [1] : []
    content {
      sid       = "SessionRuntimeControl"
      actions   = ["lambda:CreateMicrovmAuthToken", "lambda:GetMicrovm", "lambda:TerminateMicrovm"]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role" "agents_outbox" {
  name               = "${local.name}-agents-outbox"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "agents_outbox" {
  source_policy_documents = [data.aws_iam_policy_document.agents_service.json]
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["agents-outbox"].arn}:*"]
  }
  statement {
    sid       = "OutboxStreams"
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"]
    resources = [aws_dynamodb_table.agents.stream_arn, aws_dynamodb_table.runs.stream_arn]
  }
  statement {
    sid       = "ListStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }
  statement {
    sid       = "OutboxQueue"
    actions   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.agents.arn]
  }
  statement {
    sid       = "DeliveryState"
    actions   = local.integration_table_read_write_actions
    resources = [aws_dynamodb_table.integrations.arn]
  }
  statement {
    sid       = "DeliveryCredentials"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = [local.integration_credential_secret_arn]
  }
  dynamic "statement" {
    for_each = length(concat(local.notifier_secret_arns, local.integration_oauth_app_secret_arns)) > 0 ? [1] : []
    content {
      sid       = "DeliveryConfiguration"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = distinct(concat(local.notifier_secret_arns, local.integration_oauth_app_secret_arns))
    }
  }
  statement {
    sid       = "SessionSchedules"
    actions   = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule"]
    resources = ["arn:${data.aws_partition.current.partition}:scheduler:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:schedule/${aws_scheduler_schedule_group.things.name}/*"]
  }
  statement {
    sid       = "PassSessionScheduleRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.thing_schedule_invoke.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "agents_outbox" {
  name   = "session-outbox"
  role   = aws_iam_role.agents_outbox.id
  policy = data.aws_iam_policy_document.agents_outbox.json
}
