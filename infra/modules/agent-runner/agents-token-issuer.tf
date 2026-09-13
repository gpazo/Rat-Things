resource "aws_iam_role" "agents_token_issuer" {
  name               = "${local.name}-agents-token-issuer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "agents_token_issuer" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["agents-api"].arn}:*"]
  }
  statement {
    sid       = "IssueTokenIndex"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.agents.arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["resource:*:${sha256("api_tokens")}:*", "list:*:${sha256("api_tokens")}"]
    }
  }
  statement {
    sid       = "IssueTokenBody"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.definitions.arn}/owners/*/agents/${sha256("api_tokens")}/*"]
  }
  statement {
    sid       = "EncryptTokenBody"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
  }
  # DynamoDB decrypts the table key on behalf of writers as well as readers.
  # This grants no item read and cannot decrypt unrelated Secrets Manager data.
  statement {
    sid       = "UseTokenIndexKey"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${data.aws_region.current.region}.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:dynamodb:tableName"
      values   = [aws_dynamodb_table.agents.name]
    }
  }
}

resource "aws_iam_role_policy" "agents_token_issuer" {
  name   = "issue-tokens"
  role   = aws_iam_role.agents_token_issuer.id
  policy = data.aws_iam_policy_document.agents_token_issuer.json
}
