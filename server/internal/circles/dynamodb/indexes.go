// Package dynamodb is the circles column's DynamoDB adapter: one table,
// one partition per circle.
package dynamodb

// The circles table's three indexes, as provisioned by
// server/provision/modules/storage/circles_table.tf. Each is sparse: only
// the item kinds that set its range attribute appear in it.
const (
	// ByTypeReceivedIndex orders posts and activity by arrival, for history
	// paging and the activity walk.
	ByTypeReceivedIndex = "by-type-received"
	ByTypeReceivedSK    = "gsi1sk"

	// ByAccountIndex lists every circle an account is a member of.
	ByAccountIndex = "by-account"
	ByAccountPK    = "accountId"

	// ByTypeUpdatedIndex orders posts by last change, for the forward walk.
	ByTypeUpdatedIndex = "by-type-updated"
	ByTypeUpdatedSK    = "gsi3sk"
)
