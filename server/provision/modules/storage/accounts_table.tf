# One partition per account (account#<id>): its profile, its devices, and
# the sign-in providers linked to it. A second, tiny partition per provider
# identity (provider#<provider>:<sub>) maps a sign-in back to its account,
# so account ids can be internal rather than the provider's own subject.
#
# Recreated with a sort key, since DynamoDB can't add one in place; the
# old single-key table lives on as accounts_old_table.tf until nothing
# reads it.
resource "aws_dynamodb_table" "accounts" {
  name         = "${var.name_prefix}-accounts"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "pk"
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  deletion_protection_enabled = var.deletion_protection
}
