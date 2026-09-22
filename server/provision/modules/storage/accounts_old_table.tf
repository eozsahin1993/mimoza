# The pre-rewrite accounts table, renamed so the current relay keeps
# working while the rewrite lands: the encrypted circle-membership
# manifest (internal/account/dynamodb), keyed on the bare account id, and
# the Apple refresh token account deletion revokes with
# (internal/auth/dynamodb), keyed under its own "apple-refresh#" prefix.
# No sort key — each kind is a single document looked up by a known key.
# Deleted once nothing reads it.
resource "aws_dynamodb_table" "accounts_old" {
  name         = "${var.name_prefix}-accounts-old"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  deletion_protection_enabled = var.deletion_protection
}
