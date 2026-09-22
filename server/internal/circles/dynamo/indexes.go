// Package dynamodb is the circles column's DynamoDB adapter: one table,
// one partition per circle.
package dynamo

// The circles table's three indexes, as provisioned by
// server/provision/modules/storage/circles_table.tf. Each is sparse: only
// the item kinds that set its range attribute appear in it.
const (
	// ByTypeReceivedIndex orders one type's entries by arrival, for
	// history paging and the activity walk. The type is in the partition
	// key, not a prefix on the sort key: a range over a shared partition
	// would otherwise run past its own type into the next one.
	ByTypeReceivedIndex = "by-type-received"
	ByTypeReceivedPK    = "typeReceivedPk"
	ByTypeReceivedKey   = "typeReceivedKey"

	// ByAccountIndex lists every circle an account is a member of.
	ByAccountIndex = "by-account"
	ByAccountPK    = "accountId"

	// ByTypeUpdatedIndex orders posts by last change, for the forward walk.
	ByTypeUpdatedIndex = "by-type-updated"
	ByTypeUpdatedPK    = "typeUpdatedPk"
	ByTypeUpdatedKey   = "typeUpdatedKey"
)
