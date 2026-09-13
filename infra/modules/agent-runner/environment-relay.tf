locals {
  environment_relay_enabled = var.environment_relay_image != null
}

resource "aws_ecr_repository" "environment_relay" {
  name                 = "${local.name}/environment-relay"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
  tags = local.tags
}

data "aws_availability_zones" "environment_relay" {
  count = local.environment_relay_enabled ? 1 : 0
  state = "available"
}

resource "aws_vpc" "environment_relay" {
  count                = local.environment_relay_enabled ? 1 : 0
  cidr_block           = "10.74.0.0/24"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = local.tags
}

resource "aws_internet_gateway" "environment_relay" {
  count  = local.environment_relay_enabled ? 1 : 0
  vpc_id = aws_vpc.environment_relay[0].id
  tags   = local.tags
}

resource "aws_subnet" "environment_relay" {
  count             = local.environment_relay_enabled ? 2 : 0
  vpc_id            = aws_vpc.environment_relay[0].id
  availability_zone = data.aws_availability_zones.environment_relay[0].names[count.index]
  cidr_block        = cidrsubnet(aws_vpc.environment_relay[0].cidr_block, 1, count.index)
  tags              = local.tags
}

resource "aws_route_table" "environment_relay" {
  count  = local.environment_relay_enabled ? 1 : 0
  vpc_id = aws_vpc.environment_relay[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.environment_relay[0].id
  }
  tags = local.tags
}

resource "aws_route_table_association" "environment_relay" {
  count          = local.environment_relay_enabled ? 2 : 0
  subnet_id      = aws_subnet.environment_relay[count.index].id
  route_table_id = aws_route_table.environment_relay[0].id
}

resource "aws_security_group" "environment_relay_origin" {
  count  = local.environment_relay_enabled ? 1 : 0
  name   = "${local.name}-relay-origin"
  vpc_id = aws_vpc.environment_relay[0].id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_security_group" "environment_relay_task" {
  count  = local.environment_relay_enabled ? 1 : 0
  name   = "${local.name}-relay-task"
  vpc_id = aws_vpc.environment_relay[0].id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.environment_relay_origin[0].id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_lb" "environment_relay" {
  count              = local.environment_relay_enabled ? 1 : 0
  name               = "${local.name}-relay"
  load_balancer_type = "application"
  subnets            = aws_subnet.environment_relay[*].id
  security_groups    = [aws_security_group.environment_relay_origin[0].id]
  # Input may wait five minutes for an executor before returning its HTTP status.
  idle_timeout = 360
  tags         = local.tags
}

resource "aws_lb_target_group" "environment_relay" {
  count                = local.environment_relay_enabled ? 1 : 0
  name                 = "${local.name}-relay"
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.environment_relay[0].id
  deregistration_delay = 30
  health_check { path = "/health" }
  tags = local.tags
}

resource "aws_lb_listener" "environment_relay" {
  count             = local.environment_relay_enabled ? 1 : 0
  load_balancer_arn = aws_lb.environment_relay[0].arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.environment_relay_origin_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  lifecycle {
    precondition {
      condition     = var.environment_relay_origin_hostname != null && var.environment_relay_origin_certificate_arn != null
      error_message = "An enabled relay requires an origin hostname and matching ACM certificate. Point the hostname at environment_relay_origin_dns_name."
    }
  }
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.environment_relay[0].arn
  }
}

data "aws_cloudfront_cache_policy" "environment_relay" {
  count = local.environment_relay_enabled ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "environment_relay" {
  count = local.environment_relay_enabled ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "environment_relay" {
  count           = local.environment_relay_enabled ? 1 : 0
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.name} encrypted executor relay"
  origin {
    domain_name = var.environment_relay_origin_hostname
    origin_id   = "environment-relay"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    target_origin_id         = "environment-relay"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.environment_relay[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.environment_relay[0].id
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
  tags = local.tags
}

data "aws_iam_policy_document" "environment_relay_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "environment_relay" {
  count              = local.environment_relay_enabled ? 1 : 0
  name               = "${local.name}-relay"
  assume_role_policy = data.aws_iam_policy_document.environment_relay_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "environment_relay_launch" {
  count              = local.environment_relay_enabled ? 1 : 0
  name               = "${local.name}-relay-launch"
  assume_role_policy = data.aws_iam_policy_document.environment_relay_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "environment_relay_launch" {
  count      = local.environment_relay_enabled ? 1 : 0
  role       = aws_iam_role.environment_relay_launch[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "environment_relay" {
  count = local.environment_relay_enabled ? 1 : 0
  role  = aws_iam_role.environment_relay[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:TransactWriteItems"], Resource = aws_dynamodb_table.agents.arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.definitions.arn}/owners/*" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = "arn:${data.aws_partition.current.partition}:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:${local.name}/connections/agents/environments/*" },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.data.arn }
  ] })
}

resource "aws_cloudwatch_log_group" "environment_relay" {
  count             = local.environment_relay_enabled ? 1 : 0
  name              = "/aws/ecs/${local.name}-environment-relay"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_ecs_cluster" "environment_relay" {
  count = local.environment_relay_enabled ? 1 : 0
  name  = "${local.name}-environment-relay"
  tags  = local.tags
}

resource "aws_ecs_task_definition" "environment_relay" {
  count                    = local.environment_relay_enabled ? 1 : 0
  family                   = "${local.name}-environment-relay"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.environment_relay_launch[0].arn
  task_role_arn            = aws_iam_role.environment_relay[0].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name                   = "relay", image = var.environment_relay_image, essential = true,
    readonlyRootFilesystem = false,
    portMappings           = [{ containerPort = 8080, protocol = "tcp" }],
    environment = [for name, value in merge(local.lambda_common_environment, {
      AGENTS_TABLE_NAME            = aws_dynamodb_table.agents.name,
      AGENTS_ENVIRONMENT_RELAY_URL = "https://${aws_cloudfront_distribution.environment_relay[0].domain_name}",
      AWS_REGION                   = data.aws_region.current.region
    }) : { name = name, value = value }],
    logConfiguration = {
      logDriver = "awslogs", options = {
        awslogs-group  = aws_cloudwatch_log_group.environment_relay[0].name,
        awslogs-region = data.aws_region.current.region, awslogs-stream-prefix = "relay"
      }
    }
  }])
  tags = local.tags
}

resource "aws_ecs_service" "environment_relay" {
  count                              = local.environment_relay_enabled ? 1 : 0
  name                               = "environment-relay"
  cluster                            = aws_ecs_cluster.environment_relay[0].id
  task_definition                    = aws_ecs_task_definition.environment_relay[0].arn
  launch_type                        = "FARGATE"
  desired_count                      = 1
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 30
  network_configuration {
    subnets          = aws_subnet.environment_relay[*].id
    security_groups  = [aws_security_group.environment_relay_task[0].id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.environment_relay[0].arn
    container_name   = "relay"
    container_port   = 8080
  }
  depends_on = [aws_lb_listener.environment_relay, aws_iam_role_policy.environment_relay, aws_iam_role_policy_attachment.environment_relay_launch]
  tags       = local.tags
}
