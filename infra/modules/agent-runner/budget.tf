# Billing is shared across owners and services. An account filter includes model
# and infrastructure costs without depending on resource-tag cost allocation.
# No budget action, IAM denial, worker shutdown or admission check is attached.
resource "aws_budgets_budget" "account_monthly" {
  count = var.budget_alert == null ? 0 : 1

  account_id   = data.aws_caller_identity.current.account_id
  name         = "${local.name}-${data.aws_region.current.region}-account-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_alert.monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "LinkedAccount"
    values = [data.aws_caller_identity.current.account_id]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert.email_addresses
  }

  tags = local.tags
}
