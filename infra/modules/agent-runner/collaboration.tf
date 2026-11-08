variable "oidc_providers" {
  description = "Trusted access-token issuers and public desktop login configuration. Configuring a provider enables the role-authorized shared Agents API."
  type = list(object({
    id                    = string
    issuer                = string
    jwksUri               = string
    clientId              = string
    audience              = optional(string)
    profile               = optional(string, "jwt_access")
    authorizationEndpoint = string
    tokenEndpoint         = string
    redirectUri           = string
    scopes                = optional(list(string), ["openid", "profile"])
    requiredScopes        = optional(list(string), [])
    apiScopes             = optional(list(string))
  }))
  default = []

  validation {
    condition = length(var.oidc_providers) <= 4 && length(distinct([for provider in var.oidc_providers : provider.id])) == length(var.oidc_providers) && alltrue([
      for provider in var.oidc_providers :
      contains(["jwt_access", "cognito_access"], provider.profile) &&
      length(provider.clientId) > 0 && length(provider.id) > 0 &&
      (provider.profile != "jwt_access" || try(length(provider.audience) > 0, false)) &&
      alltrue([for url in [provider.issuer, provider.jwksUri, provider.authorizationEndpoint, provider.tokenEndpoint] : can(regex("^https://[^/]+", url))]) &&
      can(regex("^http://127\\.0\\.0\\.1:[0-9]+/", provider.redirectUri))
    ])
    error_message = "Configure at most four uniquely named HTTPS OIDC providers, an explicit access-token profile/client, an API audience for jwt_access, and a registered loopback redirect URI."
  }
}

locals {
  team_api_enabled = length(var.oidc_providers) > 0
  team_oidc_environment = {
    TEAM_OIDC_PROVIDERS_JSON = jsonencode([for provider in var.oidc_providers : {
      for key, value in provider : key => value if value != null
    }])
  }
}

resource "aws_iam_role" "agents_shared" {
  count              = local.team_api_enabled ? 1 : 0
  name               = "${local.name}-agents-shared"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "agents_shared" {
  count                   = local.team_api_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.agents_service.json]
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.agents_shared_web[0].arn}:*",
      "${aws_cloudwatch_log_group.agents_shared_web_local[0].arn}:*",
    ]
  }
  statement {
    sid       = "AbortArtifactUploads"
    actions   = ["s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.artifacts.arn}/owners/*"]
  }
}

resource "aws_iam_role_policy" "agents_shared" {
  count  = local.team_api_enabled ? 1 : 0
  role   = aws_iam_role.agents_shared[0].id
  policy = data.aws_iam_policy_document.agents_shared[0].json
}

output "shared_agents_api_base_url" {
  description = "OIDC-authenticated team Agents API; null when no identity providers are configured."
  value       = local.team_api_enabled ? aws_cloudformation_stack.agents_shared_web[0].outputs["BaseUrl"] : null
}
