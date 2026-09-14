variable "enable_validation_observer" {
  description = "Create opt-in infrastructure for a one-off AWS-hosted API test client. Does not start a task."
  type        = bool
  default     = false
}

variable "validation_observer_image" {
  description = "Accepted ARM64 validation-client image pinned by digest."
  type        = string
  default     = null
  validation {
    condition     = var.validation_observer_image == null ? true : can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9/_-]+@sha256:[0-9a-f]{64}$", var.validation_observer_image))
    error_message = "Pin a private ECR observer image by SHA-256 digest."
  }
}

locals {
  observer_name    = "${local.name_prefix}-${var.deployment_id}-observer"
  observer_network = module.agent_runner.agents_observer_network
  observer_assume  = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ecs-tasks.amazonaws.com" } }] })
}

resource "aws_ecr_repository" "observer" {
  count                = var.enable_validation_observer ? 1 : 0
  name                 = "${local.name_prefix}-${var.deployment_id}/validation-observer"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "observer" {
  count             = var.enable_validation_observer ? 1 : 0
  name              = "/rat-things/${local.observer_name}"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_iam_role" "observer" {
  count              = var.enable_validation_observer ? 1 : 0
  name               = local.observer_name
  assume_role_policy = local.observer_assume
  tags               = local.tags
}

resource "aws_iam_role_policy" "observer" {
  count = var.enable_validation_observer ? 1 : 0
  role  = aws_iam_role.observer[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "lambda:InvokeFunctionUrl", Resource = local.observer_network.token_issuer_function_arn, Condition = { StringEquals = { "lambda:FunctionUrlAuthType" = "AWS_IAM" } } },
    { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = local.observer_network.token_issuer_function_arn, Condition = { Bool = { "lambda:InvokedViaFunctionUrl" = "true" } } }
  ] })
}

resource "aws_iam_role" "observer_execution" {
  count              = var.enable_validation_observer ? 1 : 0
  name               = "${local.observer_name}-execution"
  assume_role_policy = local.observer_assume
  tags               = local.tags
}

resource "aws_iam_role_policy" "observer_execution" {
  count = var.enable_validation_observer ? 1 : 0
  role  = aws_iam_role.observer_execution[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = aws_ecr_repository.observer[0].arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.observer[0].arn}:*" }
  ] })
}

resource "aws_security_group" "observer" {
  count  = var.enable_validation_observer ? 1 : 0
  name   = local.observer_name
  vpc_id = local.observer_network.vpc_id
  # No inbound connections. The observer reaches the public HTTPS API and AWS.
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_ecs_task_definition" "observer" {
  count                    = var.enable_validation_observer && var.validation_observer_image != null ? 1 : 0
  family                   = local.observer_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  task_role_arn            = aws_iam_role.observer[0].arn
  execution_role_arn       = aws_iam_role.observer_execution[0].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name = "observer", image = var.validation_observer_image, essential = true,
    user = "1000:1000", linuxParameters = { initProcessEnabled = true },
    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "AWS_E2E", value = "true" },
      { name = "AWS_E2E_REAL_CODEX", value = "true" },
      { name = "AWS_E2E_ENABLE_EC2_WORKER", value = "true" },
      { name = "AWS_E2E_CODEX_MODEL_ID", value = var.codex_model_id },
      { name = "RAT_THINGS_AGENTS_API_URL", value = module.agent_runner.agents_api_base_url },
      { name = "AWS_E2E_SOAK_SECONDS", value = "0" }
    ],
    logConfiguration = { logDriver = "awslogs", options = {
      "awslogs-region" = var.aws_region, "awslogs-group" = aws_cloudwatch_log_group.observer[0].name, "awslogs-stream-prefix" = "probe"
    } }
  }])
  tags = local.tags
  lifecycle {
    precondition {
      condition     = var.enable_ec2_worker && var.environment_relay_image != null
      error_message = "The observer requires the dedicated HTTPS API and EC2 Session backend."
    }
  }
}

output "validation_observer" {
  value = var.enable_validation_observer ? {
    repository_url    = aws_ecr_repository.observer[0].repository_url
    task_definition   = try(aws_ecs_task_definition.observer[0].arn, null)
    cluster_arn       = local.observer_network.cluster_arn
    subnet_ids        = local.observer_network.subnet_ids
    security_group_id = aws_security_group.observer[0].id
    log_group         = aws_cloudwatch_log_group.observer[0].name
  } : null
}
