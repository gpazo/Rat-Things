locals {
  relay_endpoint_services = local.environment_relay_enabled ? toset([
    "ecr.api", "ecr.dkr", "logs", "secretsmanager", "sts", "ssm", "ssmmessages",
    "ec2", "lambda", "lambda-microvm", "events", "sqs",
  ]) : toset([])
}

resource "aws_security_group" "relay_endpoints" {
  count  = local.environment_relay_enabled ? 1 : 0
  name   = "${local.name}-relay-endpoints"
  vpc_id = aws_vpc.environment_relay[0].id
  ingress {
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = [aws_vpc.environment_relay[0].cidr_block]
  }
  tags = local.tags
}

resource "aws_vpc_endpoint" "relay_api" {
  for_each            = local.relay_endpoint_services
  vpc_id              = aws_vpc.environment_relay[0].id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.environment_relay[*].id
  security_group_ids  = [aws_security_group.relay_endpoints[0].id]
  private_dns_enabled = true
  tags                = local.tags
}

resource "aws_vpc_endpoint" "relay_storage" {
  for_each          = local.environment_relay_enabled ? toset(["s3", "dynamodb"]) : toset([])
  vpc_id            = aws_vpc.environment_relay[0].id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.environment_relay[0].id]
  tags              = local.tags
}
