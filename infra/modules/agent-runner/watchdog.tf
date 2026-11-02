resource "aws_iam_role" "watchdog" {
  count              = var.enable_watchdog ? 1 : 0
  name               = "${local.name}-watchdog"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "watchdog" {
  count = var.enable_watchdog ? 1 : 0
  # Judge Sessions, retry dispatch and reports use these capabilities directly,
  # including when the outbox consumer is unavailable.
  statement {
    sid       = "AgentsResources"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.agents.arn]
  }
  statement {
    sid       = "SessionExecutions"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.runs.arn]
  }
  statement {
    sid       = "DeliveryFenceRelease"
    actions   = ["dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.runs.arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["delivery#*"]
    }
  }
  statement {
    sid     = "SessionObjectRead"
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.definitions.arn}/owners/*/agents/*",
      "${aws_s3_bucket.artifacts.arn}/owners/*",
    ]
  }
  statement {
    sid     = "SessionObjectWrite"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.definitions.arn}/owners/*/agents/*",
      "${aws_s3_bucket.artifacts.arn}/owners/*/sessions/*/*/launch-*.json",
      "${aws_s3_bucket.artifacts.arn}/owners/*/runs/*/input-*.json",
    ]
  }
  statement {
    sid       = "DispatchExecutions"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runs.arn]
  }
  statement {
    sid       = "DataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
  }
  dynamic "statement" {
    for_each = var.enable_microvm ? [1] : []
    content {
      sid       = "SessionRuntimeControl"
      actions   = ["lambda:CreateMicrovmAuthToken", "lambda:GetMicrovm", "lambda:TerminateMicrovm"]
      resources = [awscc_lambda_microvm_image.runner[0].image_arn]
    }
  }
  dynamic "statement" {
    for_each = var.enable_ec2_worker ? [1] : []
    content {
      sid       = "SessionEc2Inspection"
      actions   = ["ec2:DescribeInstances"]
      resources = ["*"]
    }
  }
  dynamic "statement" {
    for_each = var.enable_ec2_worker ? [1] : []
    content {
      sid       = "SessionEc2Cancellation"
      actions   = ["ec2:TerminateInstances"]
      resources = ["${local.ec2_worker_prefix}:instance/*"]
      condition {
        test     = "StringEquals"
        variable = "ec2:ResourceTag/RatDeployment"
        values   = [local.name]
      }
    }
  }
  statement {
    sid       = "WatchdogScan"
    actions   = ["dynamodb:Scan"]
    resources = [aws_dynamodb_table.agents.arn, aws_dynamodb_table.runs.arn]
  }
  statement {
    sid     = "WatchdogAlarms"
    actions = ["cloudwatch:DescribeAlarms"]
    resources = [
      aws_cloudwatch_metric_alarm.run_dlq.arn,
      aws_cloudwatch_metric_alarm.state_stream_failures.arn,
      aws_cloudwatch_metric_alarm.notifier_delivery_failures.arn,
      aws_cloudwatch_metric_alarm.notifier_dlq_delivery_failures.arn,
    ]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["watchdog"].arn}:*"]
  }
  statement {
    sid       = "DeliveryState"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.integrations.arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["OWNER#*"]
    }
  }
  statement {
    sid       = "DeliveryRefreshLocks"
    actions   = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.integrations.arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["OAUTH_REFRESH#*"]
    }
  }
  statement {
    sid       = "DeliveryCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.integration_credential_secret_arn]
  }
  statement {
    sid     = "DeliveryCredentialRefresh"
    actions = ["secretsmanager:PutSecretValue"]
    # connectionCredentialName uses a 32-character owner hash. Agent secrets
    # use the separate connections/agents/ namespace and remain read-only.
    resources = ["arn:${data.aws_partition.current.partition}:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:${local.name}/connections/????????????????????????????????/*"]
  }
  dynamic "statement" {
    for_each = length(concat(local.notifier_secret_arns, local.integration_oauth_app_secret_arns)) > 0 ? [1] : []
    content {
      sid       = "DeliveryConfiguration"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = distinct(concat(local.notifier_secret_arns, local.integration_oauth_app_secret_arns))
    }
  }
}
resource "aws_iam_role_policy" "watchdog" {
  count  = var.enable_watchdog ? 1 : 0
  name   = "watchdog"
  role   = aws_iam_role.watchdog[0].id
  policy = data.aws_iam_policy_document.watchdog[0].json
}
resource "aws_cloudwatch_event_rule" "watchdog" {
  count               = var.enable_watchdog ? 1 : 0
  name                = "${local.name}-watchdog"
  description         = "Inspect bounded Session activity and deliver independent watchdog findings"
  schedule_expression = var.watchdog_schedule_expression
  tags                = local.tags
}
resource "aws_cloudwatch_event_target" "watchdog" {
  count     = var.enable_watchdog ? 1 : 0
  rule      = aws_cloudwatch_event_rule.watchdog[0].name
  target_id = "watchdog"
  arn       = aws_lambda_function.this["watchdog"].arn
  retry_policy {
    maximum_event_age_in_seconds = 600
    maximum_retry_attempts       = 2
  }
}
resource "aws_lambda_permission" "eventbridge_watchdog" {
  count         = var.enable_watchdog ? 1 : 0
  statement_id  = "AllowEventBridgeWatchdog"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["watchdog"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.watchdog[0].arn
}

check "watchdog_configuration" {
  assert {
    condition = !var.enable_watchdog || (
      length(trimspace(var.watchdog_owner_id)) > 0 &&
      var.watchdog_max_candidates >= 1 && var.watchdog_max_candidates <= 100 && floor(var.watchdog_max_candidates) == var.watchdog_max_candidates &&
      var.watchdog_max_judges_per_tick >= 0 && var.watchdog_max_judges_per_tick <= 10 && floor(var.watchdog_max_judges_per_tick) == var.watchdog_max_judges_per_tick &&
      var.watchdog_long_running_seconds >= 60 && var.watchdog_long_running_seconds <= 604800 &&
      var.watchdog_recent_failure_seconds >= var.watchdog_retry_backoff_seconds && var.watchdog_recent_failure_seconds <= 604800 &&
      var.watchdog_stuck_seconds >= 60 && var.watchdog_stuck_seconds <= 604800 &&
      var.watchdog_retry_backoff_seconds >= 1 && var.watchdog_retry_backoff_seconds <= 86400 &&
      var.watchdog_judge_timeout_seconds >= 60 && var.watchdog_judge_timeout_seconds <= 86400 &&
      var.watchdog_retention_seconds >= 86400 && var.watchdog_retention_seconds <= 31536000 &&
      var.watchdog_loop_confidence >= 0.9 && var.watchdog_loop_confidence <= 1 &&
      (var.watchdog_max_judges_per_tick == 0 || try(contains(local.model_catalog_model_ids, coalesce(var.watchdog_model, local.model_catalog_default_model)), false))
    )
    error_message = "Watchdog requires bounded thresholds, confidence at least 0.9, and an approved judge model when judging is enabled."
  }
}
