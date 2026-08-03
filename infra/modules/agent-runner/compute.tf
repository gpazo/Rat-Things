resource "aws_ecr_repository" "worker" {
  name                 = "${local.name}-worker"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.force_destroy_data

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.tags, { Name = "${local.name}-worker" })
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged worker images after seven days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_ecs_cluster" "this" {
  name = "${local.name}-runners"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(local.tags, { Name = "${local.name}-runners" })
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_worker.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  ephemeral_storage {
    size_in_gib = var.worker_ephemeral_storage_gib
  }

  volume {
    name = "workspace"
  }

  container_definitions = jsonencode([
    {
      name      = "agent-runner"
      image     = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_tag}"
      essential = true
      environment = concat([
        { name = "ALLOWED_REPOSITORY_HOSTS", value = join(",", var.allowed_repository_hosts) },
        { name = "ALLOWED_SANDBOX_MODES", value = join(",", var.allowed_sandbox_modes) },
        { name = "ALLOW_AGENT_AWS_CREDENTIAL_CHAIN", value = tostring(var.allow_agent_aws_credential_chain) },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.id },
        { name = "AWS_DEFAULT_REGION", value = data.aws_region.current.region },
        { name = "AWS_REGION", value = data.aws_region.current.region },
        { name = "DEFAULT_AGENT_DRIVER", value = var.default_agent_driver },
        { name = "DEFAULT_EXECUTION_BACKEND", value = "ecs" },
        { name = "RUNS_TABLE_NAME", value = aws_dynamodb_table.runs.name },
        { name = "WORKSPACE_ROOT", value = "/workspace" },
        { name = "RUN_AGENT_GID", value = "10001" },
        { name = "RUN_AGENT_UID", value = "10001" },
        ], local.bedrock_api_key_secret_arn == null ? [] : [
        { name = "BEDROCK_API_KEY_SECRET_ARN", value = local.bedrock_api_key_secret_arn },
      ])
      linuxParameters = {
        initProcessEnabled = true
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.ecs.name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = "worker"
        }
      }
      mountPoints = [
        {
          containerPath = "/workspace"
          readOnly      = false
          sourceVolume  = "workspace"
        },
      ]
      portMappings = []
    },
  ])

  tags = merge(local.tags, { Name = "${local.name}-worker" })

  depends_on = [
    aws_iam_role_policy.ecs_execution,
    aws_iam_role_policy.ecs_worker,
  ]
}
