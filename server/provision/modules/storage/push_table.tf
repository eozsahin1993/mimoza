# Standalone table for push routing state. PK = pushRoutingId, SK
# distinguishes the prefs row ("prefs") from each
# device's row ("device#<deviceId>"), same single-table shape as the
# invites and log tables.
#
# Circle addresses are durable state, how a device stays reachable between
# posts, and never expire. Invite and pending-request addresses carry an
# expiresAt matching the invite's retention, so one a phone abandons still
# goes away (see push/dynamodb).
#
# What this table deliberately does not hold: account ids, circle ids, sync
# ids, and any list of which routing ids belong together. Someone reading
# it should find opaque ids, push tokens, salted hashes, kinds and
# category bits — nothing that groups people. The fanout hash is salted per
# row precisely so a circle's rows don't share an identical value that
# would cluster its membership straight out of a table scan.
resource "aws_dynamodb_table" "push" {
  name         = "${var.name_prefix}-push"
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

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  deletion_protection_enabled = var.deletion_protection
}
