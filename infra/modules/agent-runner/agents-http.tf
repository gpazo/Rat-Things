resource "aws_lb_target_group" "agents_http" {
  count       = local.environment_relay_enabled ? 1 : 0
  name        = "${local.name}-agents"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.environment_relay[0].id
  health_check { path = "/health" }
  tags = local.tags
}

resource "aws_lb_listener_rule" "agents_http" {
  count        = local.environment_relay_enabled ? 1 : 0
  listener_arn = aws_lb_listener.environment_relay[0].arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.agents_http[0].arn
  }
  condition {
    path_pattern { values = ["/v1/*", "/.well-known/agents-api"] }
  }
}

resource "aws_iam_role" "agents_http" {
  count              = local.environment_relay_enabled ? 1 : 0
  name               = "${local.name}-agents-http"
  assume_role_policy = data.aws_iam_policy_document.environment_relay_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "agents_http" {
  count  = local.environment_relay_enabled ? 1 : 0
  role   = aws_iam_role.agents_http[0].id
  policy = data.aws_iam_policy_document.agents_service.json
}

resource "aws_cloudwatch_log_group" "agents_http" {
  count             = local.environment_relay_enabled ? 1 : 0
  name              = "/aws/ecs/${local.name}-agents"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_ecs_task_definition" "agents_http" {
  count                    = local.environment_relay_enabled ? 1 : 0
  family                   = "${local.name}-agents"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "2048"
  memory                   = "8192"
  execution_role_arn       = aws_iam_role.environment_relay_launch[0].arn
  task_role_arn            = aws_iam_role.agents_http[0].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name                   = "api", image = var.environment_relay_image, essential = true,
    command                = ["node", "/app/agents-server.mjs"],
    readonlyRootFilesystem = true,
    portMappings           = [{ containerPort = 8080, protocol = "tcp" }],
    environment = [for name, value in merge(local.executor_environment, {
      AWS_REGION              = data.aws_region.current.region,
      AGENTS_TABLE_NAME       = aws_dynamodb_table.agents.name,
      AGENTS_PUBLIC_BASE_URL  = "https://${var.environment_relay_origin_hostname}/v1",
      AGENTS_TOKEN_ISSUER_URL = "${aws_lambda_function_url.agents.function_url}v1/auth/tokens",
      ALLOW_OWNER_HEADER      = "false"
    }) : { name = name, value = value }],
    logConfiguration = {
      logDriver = "awslogs", options = {
        awslogs-group  = aws_cloudwatch_log_group.agents_http[0].name,
        awslogs-region = data.aws_region.current.region, awslogs-stream-prefix = "api"
      }
    }
  }])
  tags = local.tags
}

resource "aws_ecs_service" "agents_http" {
  count                              = local.environment_relay_enabled ? 1 : 0
  name                               = "agents-http"
  cluster                            = aws_ecs_cluster.environment_relay[0].id
  task_definition                    = aws_ecs_task_definition.agents_http[0].arn
  launch_type                        = "FARGATE"
  desired_count                      = 1
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30
  network_configuration {
    subnets          = aws_subnet.environment_relay[*].id
    security_groups  = [aws_security_group.environment_relay_task[0].id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.agents_http[0].arn
    container_name   = "api"
    container_port   = 8080
  }
  depends_on = [aws_lb_listener_rule.agents_http, aws_iam_role_policy.agents_http]
  tags       = local.tags
}
