# One partition per account (account#<id>): its profile, its devices, and
# the sign-in providers linked to it. A second, tiny partition per provider
# identity (provider#<provider>:<sub>) maps a sign-in back to its account,
# so account ids can be internal rather than the provider's own subject.
#
# The pre-rewrite rows the current relay still writes — the encrypted
# recovery manifest and the Apple refresh token — sit in their own
# partitions here under a fixed sort key until they're removed.
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

  # Device-link sessions are the only rows here that expire: a keypair
  # handoff is open for minutes. Profiles, devices and sign-ins carry no
  # expiresAt at all, so the sweeper never looks at them twice.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  deletion_protection_enabled = var.deletion_protection
}
