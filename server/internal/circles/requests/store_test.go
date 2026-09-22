package requests_test

import (
	"context"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/requests"
	"mimoza-relay/internal/util/testsupport"
)

// A device waiting to be let in holds no membership, so the ask itself
// is what it watches. Asks are found by account through the same index
// memberships use, which is why a membership query filters on its own
// prefix.
func TestListRequestsForAccount_FindsEveryAskThisAccountMade(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := requests.NewStore(table)

	asker := testsupport.UniqueAccountID(t)
	stranger := testsupport.UniqueAccountID(t)
	first := seedCircle(t, table)
	second := seedCircle(t, table)

	ask(t, store, first, asker)
	ask(t, store, second, asker)
	ask(t, store, first, stranger)

	mine, err := store.ListRequestsForAccount(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 2 {
		t.Fatalf("expected both asks, got %d", len(mine))
	}
	circleIDs := map[string]bool{}
	for _, request := range mine {
		circleIDs[request.CircleID] = true
		if request.AccountID != asker {
			t.Errorf("expected only this account's asks, got %q", request.AccountID)
		}
		if request.Status != circles.RequestPending {
			t.Errorf("status = %q, want pending", request.Status)
		}
	}
	if !circleIDs[first] || !circleIDs[second] {
		t.Errorf("expected one ask per circle, got %v", circleIDs)
	}

	// An answered ask stays: the asker has to see what the answer was.
	requestID := mine[0].ID
	if err := store.DenyRequest(ctx, mine[0].CircleID, requestID); err != nil {
		t.Fatal(err)
	}
	after, err := store.ListRequestsForAccount(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	denied := 0
	for _, request := range after {
		if request.Status == circles.RequestDenied {
			denied++
		}
	}
	if denied != 1 {
		t.Errorf("expected the denial to be visible to the asker, got %d", denied)
	}
}

// An expired ask is one no admin can answer any more, so it is not
// something to still be waiting on.
func TestListRequestsForAccount_LeavesOutExpiredAsks(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := requests.NewStore(table)

	asker := testsupport.UniqueAccountID(t)
	circleID := seedCircle(t, table)

	past := time.Now().Add(-time.Hour)
	err := store.CreateRequest(ctx, circles.Request{
		ID:        "expired-" + asker,
		CircleID:  circleID,
		AccountID: asker,
		PublicKey: []byte("key"),
		Status:    circles.RequestPending,
		CreatedAt: past.Add(-time.Hour),
		ExpiresAt: past,
	})
	if err != nil {
		t.Fatal(err)
	}

	waiting, err := store.ListRequestsForAccount(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 0 {
		t.Fatalf("expected nothing to be waiting on, got %+v", waiting)
	}
}

// An ask carries the account it came from, which is the index's hash
// key. Memberships share that index, so this asserts the two do not run
// together: a circle someone only asked about is not one they are in.
func TestListRequestsForAccount_AnAskIsNotAMembership(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, requestStore := circle.NewStore(table), requests.NewStore(table)

	asker := testsupport.UniqueAccountID(t)
	circleID := seedCircle(t, table)
	ask(t, requestStore, circleID, asker)

	memberships, err := circleStore.ListMemberships(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 0 {
		t.Fatalf("an ask must not read as a membership, got %+v", memberships)
	}
}

func seedCircle(t *testing.T, table *dynamo.Table) string {
	t.Helper()
	circleID := testsupport.UniqueCircleID(t)
	founder := testsupport.UniqueAccountID(t)
	err := circle.NewStore(table).CreateCircle(context.Background(), circles.Circle{
		ID: circleID, Name: "Family", KeyVersion: 1, RosterVersion: 1, CreatedBy: founder, CreatedAt: time.Now(),
	}, circles.Member{AccountID: founder, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
	return circleID
}

func ask(t *testing.T, store *requests.Store, circleID, accountID string) {
	t.Helper()
	err := store.CreateRequest(context.Background(), circles.Request{
		ID:        "request-" + accountID,
		CircleID:  circleID,
		AccountID: accountID,
		PublicKey: []byte(accountID + "-key"),
		Status:    circles.RequestPending,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(7 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
}
