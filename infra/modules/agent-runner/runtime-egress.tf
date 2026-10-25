locals {
  worker_network_enabled = var.enable_microvm || var.enable_s3_files
  worker_internet_routes = local.worker_network_enabled && length(var.runtime_https_egress_cidrs) > 0
  # Inference and orchestration remain reachable with internet egress denied.
  worker_endpoint_services = local.worker_network_enabled ? toset(concat(
    ["bedrock-runtime", "bedrock-mantle", "secretsmanager", "events", "ssm", "logs", "sts"],
    var.enable_microvm ? ["lambda"] : [],
    var.enable_ec2_worker ? ["ssmmessages", "ecr.api", "ecr.dkr"] : [],
  )) : toset([])
}

resource "aws_security_group" "worker_endpoints" {
  count  = local.worker_network_enabled ? 1 : 0
  name   = "${local.name}-worker-endpoints"
  vpc_id = aws_vpc.s3_files[0].id
  ingress {
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = [aws_subnet.s3_files_private[0].cidr_block]
  }
  tags = local.tags
}

resource "aws_vpc_endpoint" "worker_api" {
  for_each            = local.worker_endpoint_services
  vpc_id              = aws_vpc.s3_files[0].id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.s3_files_private[0].id]
  security_group_ids  = [aws_security_group.worker_endpoints[0].id]
  private_dns_enabled = true
  tags                = local.tags
}
