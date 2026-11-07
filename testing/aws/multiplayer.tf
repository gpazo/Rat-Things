variable "enable_multiplayer_fixture" {
  description = "Create a disposable OIDC provider for multi-identity Session validation."
  type        = bool
  default     = false
}

resource "aws_cognito_user_pool" "multiplayer" {
  count = var.enable_multiplayer_fixture ? 1 : 0
  name  = "${local.name_prefix}-${var.deployment_id}-collaborators"

  admin_create_user_config { allow_admin_create_user_only = true }
  password_policy {
    minimum_length    = 20
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }
  tags = local.tags
}

resource "aws_cognito_resource_server" "multiplayer" {
  count        = var.enable_multiplayer_fixture ? 1 : 0
  identifier   = "rat-things"
  name         = "Rat Things test API"
  user_pool_id = aws_cognito_user_pool.multiplayer[0].id
  scope {
    scope_name        = "access"
    scope_description = "Authenticate to the disposable Rat Things deployment."
  }
}

resource "aws_cognito_user_pool_client" "multiplayer" {
  count        = var.enable_multiplayer_fixture ? 1 : 0
  name         = "${local.name_prefix}-${var.deployment_id}-desktop"
  user_pool_id = aws_cognito_user_pool.multiplayer[0].id

  generate_secret                      = false
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "profile", "rat-things/access"]
  callback_urls                        = ["http://127.0.0.1:38173/callback"]
  explicit_auth_flows                  = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity                = 5
  id_token_validity                    = 5
  refresh_token_validity               = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  depends_on = [aws_cognito_resource_server.multiplayer]
}

resource "aws_cognito_user_pool_domain" "multiplayer" {
  count        = var.enable_multiplayer_fixture ? 1 : 0
  domain       = "${local.name_prefix}-${var.deployment_id}-collaboration"
  user_pool_id = aws_cognito_user_pool.multiplayer[0].id
}

output "multiplayer_identity_provider" {
  value = var.enable_multiplayer_fixture ? {
    user_pool_id = aws_cognito_user_pool.multiplayer[0].id
    issuer       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.multiplayer[0].id}"
    client_id    = aws_cognito_user_pool_client.multiplayer[0].id
    login_origin = "https://${aws_cognito_user_pool_domain.multiplayer[0].domain}.auth.${var.aws_region}.amazoncognito.com"
    redirect_uri = "http://127.0.0.1:38173/callback"
  } : null
}
