resource "aws_secretsmanager_secret" "teams_webhook" {
  name                    = "${local.name}/teams-webhook"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "teams_webhook" {
  secret_id = aws_secretsmanager_secret.teams_webhook.id
  secret_string = jsonencode({
    hmac_secret = var.teams_signing_secret
  })
}

resource "aws_secretsmanager_secret" "teams_workflow" {
  name                    = "${local.name}/teams-workflow"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "teams_workflow" {
  secret_id = aws_secretsmanager_secret.teams_workflow.id
  secret_string = jsonencode({
    url = var.teams_workflow_url
  })
}

resource "aws_secretsmanager_secret" "github_webhook" {
  name                    = "${local.name}/github-webhook"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "github_webhook" {
  secret_id = aws_secretsmanager_secret.github_webhook.id
  secret_string = jsonencode({
    webhook_secret = "localstack-github-webhook-secret"
  })
}

resource "aws_secretsmanager_secret" "gitlab_webhook" {
  name                    = "${local.name}/gitlab-webhook"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "gitlab_webhook" {
  secret_id = aws_secretsmanager_secret.gitlab_webhook.id
  secret_string = jsonencode({
    signing_token = "whsec_bG9jYWxzdGFjay1naXRsYWItc2lnbmluZy1rZXkhISE="
  })
}
