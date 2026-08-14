resource "aws_cloudwatch_event_bus" "runs" {
  name = "${local.name}-runs"
  tags = local.tags
}

resource "aws_cloudwatch_event_rule" "terminal_runs" {
  name           = "${local.name}-terminal-runs"
  description    = "Deliver terminal agent-run state changes to configured channels"
  event_bus_name = aws_cloudwatch_event_bus.runs.name
  event_pattern = jsonencode({
    source      = ["rat-things.agent-runtime"]
    detail-type = ["Agent Run State"]
    detail = {
      status = ["succeeded", "failed", "cancelled"]
    }
  })
  tags = local.tags
}

data "aws_iam_policy_document" "notifier_delivery_failures" {
  statement {
    sid       = "AllowTerminalRunRuleDeliveryFailures"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.notifier_delivery_failures.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.terminal_runs.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "notifier_delivery_failures" {
  queue_url = aws_sqs_queue.notifier_delivery_failures.url
  policy    = data.aws_iam_policy_document.notifier_delivery_failures.json
}

resource "aws_cloudwatch_event_target" "notifier" {
  rule           = aws_cloudwatch_event_rule.terminal_runs.name
  event_bus_name = aws_cloudwatch_event_bus.runs.name
  target_id      = "notifier"
  arn            = aws_lambda_function.this["notifier"].arn

  dead_letter_config {
    arn = aws_sqs_queue.notifier_delivery_failures.arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }

  depends_on = [aws_sqs_queue_policy.notifier_delivery_failures]
}

resource "aws_lambda_permission" "eventbridge_notifier" {
  statement_id  = "AllowEventBridgeNotifier"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["notifier"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.terminal_runs.arn
}

data "aws_iam_policy_document" "conversation_completion_failures" {
  statement {
    sid       = "AllowConversationCompletionFailures"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.conversation_completion_failures.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.terminal_runs.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "conversation_completion_failures" {
  queue_url = aws_sqs_queue.conversation_completion_failures.url
  policy    = data.aws_iam_policy_document.conversation_completion_failures.json
}

resource "aws_cloudwatch_event_target" "conversation_completion" {
  rule           = aws_cloudwatch_event_rule.terminal_runs.name
  event_bus_name = aws_cloudwatch_event_bus.runs.name
  target_id      = "conversation-completion"
  arn            = aws_lambda_function.this["conversation-completion"].arn

  dead_letter_config {
    arn = aws_sqs_queue.conversation_completion_failures.arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }

  depends_on = [aws_sqs_queue_policy.conversation_completion_failures]
}

resource "aws_lambda_permission" "eventbridge_conversation_completion" {
  statement_id  = "AllowEventBridgeConversationCompletion"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["conversation-completion"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.terminal_runs.arn
}

resource "aws_cloudwatch_event_rule" "reconciler" {
  name                = "${local.name}-reconciler"
  description         = "Re-enqueue stale queued runs to close the DynamoDB-to-SQS crash window"
  schedule_expression = "rate(1 minute)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "reconciler" {
  rule      = aws_cloudwatch_event_rule.reconciler.name
  target_id = "reconciler"
  arn       = aws_lambda_function.this["reconciler"].arn
}

resource "aws_lambda_permission" "eventbridge_reconciler" {
  statement_id  = "AllowEventBridgeReconciler"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["reconciler"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reconciler.arn
}
