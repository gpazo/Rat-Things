data "aws_availability_zones" "s3_files" {
  count = var.enable_s3_files ? 1 : 0

  state = "available"
}

data "aws_iam_policy_document" "s3_files_assume" {
  count = var.enable_s3_files ? 1 : 0

  statement {
    sid     = "AllowS3FilesAssumeRole"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["elasticfilesystem.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:s3files:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:file-system/*"]
    }
  }
}

resource "aws_iam_role" "s3_files" {
  count = var.enable_s3_files ? 1 : 0

  name               = "${local.name}-s3-files"
  assume_role_policy = data.aws_iam_policy_document.s3_files_assume[0].json
  tags               = local.tags
}

data "aws_iam_policy_document" "s3_files" {
  count = var.enable_s3_files ? 1 : 0

  statement {
    sid       = "S3BucketPermissions"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.conversation_state[0].arn]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid = "S3ObjectPermissions"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject*",
      "s3:GetObject*",
      "s3:List*",
      "s3:PutObject*",
    ]
    resources = ["${aws_s3_bucket.conversation_state[0].arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid = "EventBridgeManage"
    actions = [
      "events:DeleteRule",
      "events:DisableRule",
      "events:EnableRule",
      "events:PutRule",
      "events:PutTargets",
      "events:RemoveTargets",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:events:*:*:rule/DO-NOT-DELETE-S3-Files*"]

    condition {
      test     = "StringEquals"
      variable = "events:ManagedBy"
      values   = ["elasticfilesystem.amazonaws.com"]
    }
  }

  statement {
    sid = "EventBridgeRead"
    actions = [
      "events:DescribeRule",
      "events:ListRuleNamesByTarget",
      "events:ListRules",
      "events:ListTargetsByRule",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:events:*:*:rule/*"]
  }
}

resource "aws_iam_role_policy" "s3_files" {
  count = var.enable_s3_files ? 1 : 0

  name   = "bucket-synchronization"
  role   = aws_iam_role.s3_files[0].id
  policy = data.aws_iam_policy_document.s3_files[0].json
}

resource "aws_s3files_file_system" "conversation_state" {
  count = var.enable_s3_files ? 1 : 0

  bucket                = aws_s3_bucket.conversation_state[0].arn
  prefix                = "runtime/"
  role_arn              = aws_iam_role.s3_files[0].arn
  accept_bucket_warning = true
  tags                  = merge(local.tags, { Name = "${local.name}-conversation-state" })

  depends_on = [
    aws_iam_role_policy.s3_files,
    aws_s3_bucket_policy.this,
    aws_s3_bucket_server_side_encryption_configuration.conversation_state,
    aws_s3_bucket_versioning.this,
  ]
}

resource "aws_s3files_access_point" "conversation_state" {
  count = var.enable_s3_files ? 1 : 0

  file_system_id = aws_s3files_file_system.conversation_state[0].id

  posix_user {
    uid = 10001
    gid = 10001
  }

  root_directory {
    path = "/conversations"

    creation_permissions {
      owner_uid   = 10001
      owner_gid   = 10001
      permissions = "0700"
    }
  }

  tags = merge(local.tags, { Name = "${local.name}-conversation-state" })
}

resource "aws_s3files_file_system_policy" "conversation_state" {
  count = var.enable_s3_files ? 1 : 0

  file_system_id = aws_s3files_file_system.conversation_state[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowOnlyRuntimeAccessPoint"
      Effect    = "Allow"
      Principal = { AWS = aws_iam_role.microvm_execution.arn }
      Action    = ["s3files:ClientMount", "s3files:ClientWrite"]
      Condition = {
        StringEquals = {
          "s3files:AccessPointArn" = aws_s3files_access_point.conversation_state[0].arn
        }
      }
    }]
  })
}

resource "aws_vpc" "s3_files" {
  count = var.enable_s3_files ? 1 : 0

  cidr_block           = var.s3_files_vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.tags, { Name = "${local.name}-s3-files" })
}

resource "aws_internet_gateway" "s3_files" {
  count = var.enable_s3_files ? 1 : 0

  vpc_id = aws_vpc.s3_files[0].id
  tags   = merge(local.tags, { Name = "${local.name}-s3-files" })
}

resource "aws_subnet" "s3_files_public" {
  count = var.enable_s3_files ? 1 : 0

  vpc_id                  = aws_vpc.s3_files[0].id
  availability_zone       = data.aws_availability_zones.s3_files[0].names[0]
  cidr_block              = cidrsubnet(var.s3_files_vpc_cidr, 1, 0)
  map_public_ip_on_launch = true

  tags = merge(local.tags, { Name = "${local.name}-s3-files-public" })
}

resource "aws_subnet" "s3_files_private" {
  count = var.enable_s3_files ? 1 : 0

  vpc_id            = aws_vpc.s3_files[0].id
  availability_zone = data.aws_availability_zones.s3_files[0].names[0]
  cidr_block        = cidrsubnet(var.s3_files_vpc_cidr, 1, 1)

  tags = merge(local.tags, { Name = "${local.name}-s3-files-private" })
}

resource "aws_eip" "s3_files_nat" {
  count = var.enable_s3_files ? 1 : 0

  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.name}-s3-files-nat" })

  depends_on = [aws_internet_gateway.s3_files]
}

resource "aws_nat_gateway" "s3_files" {
  count = var.enable_s3_files ? 1 : 0

  allocation_id = aws_eip.s3_files_nat[0].id
  subnet_id     = aws_subnet.s3_files_public[0].id
  tags          = merge(local.tags, { Name = "${local.name}-s3-files" })

  depends_on = [aws_internet_gateway.s3_files]
}

resource "aws_route_table" "s3_files_public" {
  count = var.enable_s3_files ? 1 : 0

  vpc_id = aws_vpc.s3_files[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.s3_files[0].id
  }

  tags = merge(local.tags, { Name = "${local.name}-s3-files-public" })
}

resource "aws_route_table_association" "s3_files_public" {
  count = var.enable_s3_files ? 1 : 0

  subnet_id      = aws_subnet.s3_files_public[0].id
  route_table_id = aws_route_table.s3_files_public[0].id
}

resource "aws_route_table" "s3_files_private" {
  count = var.enable_s3_files ? 1 : 0

  vpc_id = aws_vpc.s3_files[0].id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.s3_files[0].id
  }

  tags = merge(local.tags, { Name = "${local.name}-s3-files-private" })
}

resource "aws_route_table_association" "s3_files_private" {
  count = var.enable_s3_files ? 1 : 0

  subnet_id      = aws_subnet.s3_files_private[0].id
  route_table_id = aws_route_table.s3_files_private[0].id
}

resource "aws_vpc_endpoint" "s3_files_s3" {
  count = var.enable_s3_files ? 1 : 0

  vpc_id            = aws_vpc.s3_files[0].id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.s3_files_private[0].id]

  tags = merge(local.tags, { Name = "${local.name}-s3" })
}

resource "aws_vpc_endpoint" "s3_files_dynamodb" {
  count = var.enable_s3_files ? 1 : 0

  vpc_id            = aws_vpc.s3_files[0].id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.s3_files_private[0].id]

  tags = merge(local.tags, { Name = "${local.name}-dynamodb" })
}

resource "aws_security_group" "s3_files_client" {
  count = var.enable_s3_files ? 1 : 0

  name        = "${local.name}-s3-files-client"
  description = "Lambda MicroVM clients mounting the conversation state file system"
  vpc_id      = aws_vpc.s3_files[0].id

  egress {
    description = "Runtime AWS APIs, repositories, model providers, and NFS mount target"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.name}-s3-files-client" })
}

resource "aws_security_group" "s3_files_mount" {
  count = var.enable_s3_files ? 1 : 0

  name        = "${local.name}-s3-files-mount"
  description = "NFS ingress from Lambda MicroVM conversation runners"
  vpc_id      = aws_vpc.s3_files[0].id

  ingress {
    description     = "NFS from MicroVM network connector"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.s3_files_client[0].id]
  }

  tags = merge(local.tags, { Name = "${local.name}-s3-files-mount" })
}

resource "aws_s3files_mount_target" "conversation_state" {
  count = var.enable_s3_files ? 1 : 0

  file_system_id = aws_s3files_file_system.conversation_state[0].id
  subnet_id      = aws_subnet.s3_files_private[0].id
  security_groups = [
    aws_security_group.s3_files_mount[0].id,
  ]
}

data "aws_iam_policy_document" "network_connector_assume" {
  count = var.enable_s3_files ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "network_connector" {
  count = var.enable_s3_files ? 1 : 0

  name               = "${local.name}-network-connector"
  assume_role_policy = data.aws_iam_policy_document.network_connector_assume[0].json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "network_connector" {
  count = var.enable_s3_files ? 1 : 0

  role       = aws_iam_role.network_connector[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSLambdaNetworkConnectorOperatorPolicy"
}

resource "awscc_lambda_network_connector" "s3_files" {
  count = var.enable_s3_files ? 1 : 0

  name          = "${local.name}-s3-files"
  operator_role = aws_iam_role.network_connector[0].arn
  configuration = {
    vpc_egress_configuration = {
      subnet_ids                        = [aws_subnet.s3_files_private[0].id]
      security_group_ids                = [aws_security_group.s3_files_client[0].id]
      network_protocol                  = "IPv4"
      associated_compute_resource_types = ["MicroVm"]
    }
  }
  tags = local.microvm_tags

  depends_on = [
    aws_iam_role_policy_attachment.network_connector,
    aws_nat_gateway.s3_files,
    aws_route_table_association.s3_files_private,
  ]
}
