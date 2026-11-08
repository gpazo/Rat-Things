resource "aws_s3_bucket" "agents_web" {
  bucket        = "${substr(local.name, 0, 35)}-web-${local.bucket_suffix}"
  force_destroy = true

  tags = merge(local.tags, { Name = "${local.name}-web-functions" })
}

resource "aws_s3_bucket_public_access_block" "agents_web" {
  bucket                  = aws_s3_bucket.agents_web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "agents_web" {
  bucket = aws_s3_bucket.agents_web.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "agents_web" {
  bucket = aws_s3_bucket.agents_web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "agents_web_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.agents_web.arn,
      "${aws_s3_bucket.agents_web.arn}/*",
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

  statement {
    sid       = "LambdaWebFunctionCodeAccess"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.agents_web.arn}/web-functions/${local.name}/*"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values = [
        "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:web-function/${local.name}-agents-operator/revision/*",
        "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:web-function/${local.name}-agents-shared/revision/*",
      ]
    }
  }
}

resource "aws_s3_bucket_policy" "agents_web" {
  bucket = aws_s3_bucket.agents_web.id
  policy = data.aws_iam_policy_document.agents_web_bucket.json
}

resource "aws_s3_object" "agents_web" {
  bucket = aws_s3_bucket.agents_web.id
  key    = "web-functions/${local.name}/agents-web.zip"
  source = local.agents_web_zip_path
  etag   = fileexists(local.agents_web_zip_path) ? filemd5(local.agents_web_zip_path) : null

  tags = local.tags

  lifecycle {
    precondition {
      condition     = fileexists(local.agents_web_zip_path)
      error_message = "Web Function package ${local.agents_web_zip_path} does not exist. Run npm run package before planning or applying Terraform."
    }
  }

  depends_on = [aws_s3_bucket_versioning.agents_web, aws_s3_bucket_policy.agents_web]
}

resource "aws_cloudwatch_log_group" "agents_operator_web" {
  name              = "/aws/lambda/web/${local.name}-agents-operator"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "agents_operator_web_local" {
  name              = "${aws_cloudwatch_log_group.agents_operator_web.name}.local"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "agents_operator_web" {
  name               = "${local.name}-agents-operator-web"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "agents_operator_web" {
  source_policy_documents = [data.aws_iam_policy_document.agents_service.json]

  statement {
    sid       = "AbortArtifactUploads"
    actions   = ["s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }

  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.agents_operator_web.arn}:*",
      "${aws_cloudwatch_log_group.agents_operator_web_local.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "agents_operator_web" {
  name   = "agents-web"
  role   = aws_iam_role.agents_operator_web.id
  policy = data.aws_iam_policy_document.agents_operator_web.json
}

locals {
  agents_web_operator_template = {
    AWSTemplateFormatVersion = "2010-09-09"
    Resources = {
      OperatorFunction = {
        Type = "AWS::Lambda::WebFunction"
        Properties = {
          FunctionName = "${local.name}-agents-operator"
          Tags         = [for key, value in local.tags : { Key = key, Value = value }]
        }
      }
      OperatorRevision = {
        Type = "AWS::Lambda::WebFunctionRevision"
        Properties = {
          FunctionName = { Ref = "OperatorFunction" }
          Description  = "${local.name} operator Agents API"
          BuildConfig = {
            CodeConfig = {
              S3Object = {
                Bucket    = aws_s3_bucket.agents_web.id
                Key       = aws_s3_object.agents_web.key
                VersionId = aws_s3_object.agents_web.version_id
              }
            }
            RuntimeConfig = { Runtime = "nodejs24.x" }
          }
          ServiceConfig = {
            ExecutionRoleArn             = aws_iam_role.agents_operator_web.arn
            TimeoutSeconds               = 900
            MaxConcurrencyPerEnvironment = 32
            EnvironmentVariables = merge(local.executor_environment, local.model_catalog_environment, {
              AWS_LAMBDA_NODEJS_ENTRYPOINT = "agents-server.mjs"
              AGENTS_TABLE_NAME            = aws_dynamodb_table.agents.name
              AGENTS_TOKEN_ISSUER_URL      = "${aws_apigatewayv2_api.this.api_endpoint}/v1/auth/tokens"
              ALLOW_OWNER_HEADER           = "false"
            })
          }
        }
      }
      OperatorEndpoint = {
        Type = "AWS::Lambda::WebFunctionEndpoint"
        Properties = {
          EndpointName = "operator"
          EndpointType = "HomeRegion"
          AuthType     = "ApplicationManaged"
          FunctionName = { Ref = "OperatorFunction" }
          RevisionWeights = [{
            RevisionId = { "Fn::GetAtt" = ["OperatorRevision", "RevisionId"] }
            Weight     = 100
          }]
        }
      }
    }
    Outputs = {
      BaseUrl = {
        Value = {
          "Fn::Join" = ["", [
            "https://",
            { "Fn::GetAtt" = ["OperatorEndpoint", "DomainName"] },
            "/v1",
          ]]
        }
      }
      EndpointUrl = {
        Value = {
          "Fn::Join" = ["", [
            "https://",
            { "Fn::GetAtt" = ["OperatorEndpoint", "DomainName"] },
          ]]
        }
      }
    }
  }

  agents_web_shared_template = local.team_api_enabled ? {
    AWSTemplateFormatVersion = "2010-09-09"
    Resources = {
      SharedFunction = {
        Type = "AWS::Lambda::WebFunction"
        Properties = {
          FunctionName = "${local.name}-agents-shared"
          Tags         = [for key, value in local.tags : { Key = key, Value = value }]
        }
      }
      SharedRevision = {
        Type = "AWS::Lambda::WebFunctionRevision"
        Properties = {
          FunctionName = { Ref = "SharedFunction" }
          Description  = "${local.name} OIDC Agents API"
          BuildConfig = {
            CodeConfig = {
              S3Object = {
                Bucket    = aws_s3_bucket.agents_web.id
                Key       = aws_s3_object.agents_web.key
                VersionId = aws_s3_object.agents_web.version_id
              }
            }
            RuntimeConfig = { Runtime = "nodejs24.x" }
          }
          ServiceConfig = {
            ExecutionRoleArn             = aws_iam_role.agents_shared[0].arn
            TimeoutSeconds               = 900
            MaxConcurrencyPerEnvironment = 32
            EnvironmentVariables = merge(local.executor_environment, local.model_catalog_environment, local.team_oidc_environment, {
              AWS_LAMBDA_NODEJS_ENTRYPOINT = "agents-server.mjs"
              AGENTS_TABLE_NAME            = aws_dynamodb_table.agents.name
              AGENTS_AUTH_MODE             = "oidc"
              ALLOW_OWNER_HEADER           = "false"
            })
          }
        }
      }
      SharedEndpoint = {
        Type = "AWS::Lambda::WebFunctionEndpoint"
        Properties = {
          EndpointName = "shared"
          EndpointType = "HomeRegion"
          AuthType     = "ApplicationManaged"
          FunctionName = { Ref = "SharedFunction" }
          RevisionWeights = [{
            RevisionId = { "Fn::GetAtt" = ["SharedRevision", "RevisionId"] }
            Weight     = 100
          }]
        }
      }
    }
    Outputs = {
      BaseUrl = {
        Value = {
          "Fn::Join" = ["", [
            "https://",
            { "Fn::GetAtt" = ["SharedEndpoint", "DomainName"] },
            "/v1",
          ]]
        }
      }
    }
  } : null
}

resource "aws_cloudformation_stack" "agents_operator_web" {
  name          = "${local.name}-agents-operator-web"
  template_body = jsonencode(local.agents_web_operator_template)
  tags          = local.tags
  depends_on    = [aws_iam_role_policy.agents_operator_web]
}

resource "aws_cloudwatch_log_group" "agents_shared_web" {
  count = local.team_api_enabled ? 1 : 0

  name              = "/aws/lambda/web/${local.name}-agents-shared"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "agents_shared_web_local" {
  count = local.team_api_enabled ? 1 : 0

  name              = "${aws_cloudwatch_log_group.agents_shared_web[0].name}.local"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudformation_stack" "agents_shared_web" {
  count = local.team_api_enabled ? 1 : 0

  name          = "${local.name}-agents-shared-web"
  template_body = jsonencode(local.agents_web_shared_template)
  tags          = local.tags
  depends_on    = [aws_iam_role_policy.agents_shared, aws_cloudwatch_log_group.agents_shared_web]
}
