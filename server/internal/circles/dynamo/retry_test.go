package dynamo_test

import (
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/dynamo"
)

func cancelled(reasons ...string) error {
	out := &types.TransactionCanceledException{}
	for _, reason := range reasons {
		out.CancellationReasons = append(out.CancellationReasons, types.CancellationReason{Code: aws.String(reason)})
	}
	return out
}

// Two members writing to one post is contention, not an answer: the
// write was valid and running it again resolves it.
func TestWithRetry_RerunsContention(t *testing.T) {
	attempts := 0
	err := dynamo.WithRetry(func() error {
		attempts++
		if attempts < 3 {
			return cancelled("None", "TransactionConflict")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 3 {
		t.Errorf("attempts = %d, want 3", attempts)
	}
}

// A failed condition is usually the answer to the question asked, so it
// comes straight back rather than being tried again.
func TestWithRetry_LeavesAFailedConditionAlone(t *testing.T) {
	attempts := 0
	err := dynamo.WithRetry(func() error {
		attempts++
		return cancelled("ConditionalCheckFailed")
	})
	if attempts != 1 {
		t.Errorf("attempts = %d, want 1", attempts)
	}
	if dynamo.Retryable(err) {
		t.Error("a failed condition must not read as contention")
	}
}

// Contention that outlasts the retries is the caller's to repeat. Before
// this it reached them as a 500, which says nothing they can act on.
func TestWithRetry_ExhaustedContentionIsSomethingToRetry(t *testing.T) {
	err := dynamo.WithRetry(func() error { return cancelled("TransactionConflict") })

	if !errors.Is(err, circles.ErrVersionMoved) {
		t.Fatalf("expected ErrVersionMoved, got %v", err)
	}
	status, _ := circles.Status(err)
	if status != 409 {
		t.Errorf("status = %d, want 409", status)
	}
	// The cause survives for the log, even as the caller sees a conflict.
	var conflict *types.TransactionCanceledException
	if !errors.As(err, &conflict) {
		t.Error("expected the cancellation to still be readable")
	}
}
