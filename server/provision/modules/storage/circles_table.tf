# Single-table design, one partition per circle: meta, members, sealed
# keys, invites, join requests, posts, activity and each post's comments
# and reactions all live under circle#<id> — see docs/SYNC_DESIGN.md for
# the item shapes.
resource "aws_dynamodb_table" "circles" {
  name         = "${var.name_prefix}-circles"
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

  attribute {
    name = "typeReceivedKey"
    type = "S"
  }

  attribute {
    name = "typeUpdatedKey"
    type = "S"
  }

  attribute {
    name = "accountId"
    type = "S"
  }

  # Posts and activity in arrival order: history paging backward, and the
  # activity walk. Only those two item kinds set typeReceivedKey, so the
  # index is sparse.
  global_secondary_index {
    name            = "by-type-received"
    hash_key        = "pk"
    range_key       = "typeReceivedKey"
    projection_type = "ALL"
  }

  # Every circle one account belongs to — /me, rewrap, account deletion.
  # Only member rows set accountId.
  global_secondary_index {
    name            = "by-account"
    hash_key        = "accountId"
    range_key       = "sk"
    projection_type = "KEYS_ONLY"
  }

  # Posts by last change, for the forward walk: a new comment or reaction
  # moves a post's updatedAt, so it re-enters the walk. Arrival order can't
  # do this because receivedAt never moves.
  global_secondary_index {
    name            = "by-type-updated"
    hash_key        = "pk"
    range_key       = "typeUpdatedKey"
    projection_type = "ALL"
  }

  # Only invites and join requests expire.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  deletion_protection_enabled = var.deletion_protection
}
