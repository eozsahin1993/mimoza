package dynamoutil

import (
	"errors"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ConditionFailed reports whether a write lost its condition — the row
// already existed, or the value it was written against has moved.
func ConditionFailed(err error) bool {
	var failed *types.ConditionalCheckFailedException
	return errors.As(err, &failed)
}

const ConditionalCheckFailed = "ConditionalCheckFailed"

// CancelledFor returns the reason DynamoDB gave for the item at index i
// of a transaction, or "" if the failure was not a cancellation. It is
// what turns "the transaction failed" into which condition failed, so a
// caller can tell a stale key version from a missing member.
func CancelledFor(err error, i int) string {
	var cancelled *types.TransactionCanceledException
	if !errors.As(err, &cancelled) || i >= len(cancelled.CancellationReasons) {
		return ""
	}
	return aws.ToString(cancelled.CancellationReasons[i].Code)
}
