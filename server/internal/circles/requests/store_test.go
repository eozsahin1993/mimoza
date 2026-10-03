package requests_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/members"
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

// The happy path: admitted with the roster version bumped, the sealed
// keys stored under the joiner's own account, and the request marked
// answered rather than left pending.
func TestApproveRequest_AdmitsTheRequester(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, requestStore := circle.NewStore(table), requests.NewStore(table)

	joiner := testsupport.UniqueAccountID(t)
	circleID := seedCircle(t, table)
	ask(t, requestStore, circleID, joiner)

	member := circles.Member{AccountID: joiner, Role: circles.RoleMember, NotifyLevel: circles.NotifyAll}
	err := requestStore.ApproveRequest(ctx, circleID, "request-"+joiner, "admin", member,
		circles.SealedKeys{1: []byte("sealed-for-joiner")}, "Joiner", 1)
	if err != nil {
		t.Fatal(err)
	}

	memberships, err := circleStore.ListMemberships(ctx, joiner)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 {
		t.Fatalf("expected the joiner admitted, got %+v", memberships)
	}
}

// The sealed keys are built against whatever KeyVersion the caller read
// before this call — if a kick rotates the circle in between, admitting
// the requester anyway would leave them without the version the circle
// actually moved to, with nothing to flag the gap afterward.
func TestApproveRequest_RefusesAStaleKeyVersion(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, memberStore := circle.NewStore(table), members.NewStore(table)
	requestStore := requests.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	admin := testsupport.UniqueAccountID(t)
	other := admin + "-other"
	joiner := testsupport.UniqueAccountID(t)
	if err := circleStore.CreateCircle(ctx, circles.Circle{
		ID: circleID, Name: "test", KeyVersion: 1, RosterVersion: 1, CreatedBy: admin, CreatedAt: time.Now(),
	}, circles.Member{AccountID: admin, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed")); err != nil {
		t.Fatal(err)
	}
	ask(t, requestStore, circleID, other)
	if err := requestStore.ApproveRequest(ctx, circleID, "request-"+other, admin,
		circles.Member{AccountID: other, Role: circles.RoleMember, NotifyLevel: circles.NotifyAll},
		circles.SealedKeys{1: []byte("other-v1")}, "Other", 1); err != nil {
		t.Fatalf("seeding other as a member: %v", err)
	}
	ask(t, requestStore, circleID, joiner)

	// Rotates the circle to v2 — the approval below is built as if it
	// were still v1.
	if err := memberStore.RemoveMember(ctx, circleID, other, admin, "Other", 1, map[string][]byte{admin: []byte("admin-v2")}); err != nil {
		t.Fatalf("kicking other: %v", err)
	}

	member := circles.Member{AccountID: joiner, Role: circles.RoleMember, NotifyLevel: circles.NotifyAll}
	err := requestStore.ApproveRequest(ctx, circleID, "request-"+joiner, admin, member,
		circles.SealedKeys{1: []byte("sealed-v1")}, "Joiner", 1)
	if !errors.Is(err, circles.ErrVersionMoved) {
		t.Fatalf("expected ErrVersionMoved, got %v", err)
	}
}

// Taking an ask back removes it from both places it is read: the
// admin's list of what is waiting, and the asker's own list of what they
// are waiting on.
func TestDeleteRequest_RemovesAnOpenAsk(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := requests.NewStore(table)

	asker := testsupport.UniqueAccountID(t)
	circleID := seedCircle(t, table)
	ask(t, store, circleID, asker)

	if err := store.DeleteRequest(ctx, circleID, "request-"+asker); err != nil {
		t.Fatal(err)
	}

	forAdmin, err := store.ListRequests(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}
	if len(forAdmin) != 0 {
		t.Errorf("an admin must no longer see the ask, got %+v", forAdmin)
	}
	forAsker, err := store.ListRequestsForAccount(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	if len(forAsker) != 0 {
		t.Errorf("the asker must no longer be waiting, got %+v", forAsker)
	}
}

// An ask's id comes from the account alone, so the same account asking
// two circles holds the same id in both. Withdrawing from one must not
// reach into the other.
func TestDeleteRequest_OnlyTouchesTheCircleItWasMadeIn(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := requests.NewStore(table)

	asker := testsupport.UniqueAccountID(t)
	first := seedCircle(t, table)
	second := seedCircle(t, table)
	ask(t, store, first, asker)
	ask(t, store, second, asker)

	if err := store.DeleteRequest(ctx, first, "request-"+asker); err != nil {
		t.Fatal(err)
	}

	waiting, err := store.ListRequestsForAccount(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 1 || waiting[0].CircleID != second {
		t.Fatalf("expected the ask in the other circle to stand, got %+v", waiting)
	}
}

// A denial is the answer its asker is still reading, so withdrawing does
// not erase it.
func TestDeleteRequest_LeavesADeniedAskForItsAskerToRead(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := requests.NewStore(table)

	asker := testsupport.UniqueAccountID(t)
	circleID := seedCircle(t, table)
	ask(t, store, circleID, asker)
	if err := store.DenyRequest(ctx, circleID, "request-"+asker); err != nil {
		t.Fatal(err)
	}

	if err := store.DeleteRequest(ctx, circleID, "request-"+asker); !errors.Is(err, circles.ErrRequestNotFound) {
		t.Fatalf("expected ErrRequestNotFound, got %v", err)
	}

	waiting, err := store.ListRequestsForAccount(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 1 || waiting[0].Status != circles.RequestDenied {
		t.Fatalf("expected the denial to still be there, got %+v", waiting)
	}
}

// An approved ask belongs to a membership that now exists. Withdrawing
// it afterwards must neither fake success nor disturb the membership.
func TestDeleteRequest_CannotUndoAnApproval(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, store := circle.NewStore(table), requests.NewStore(table)

	joiner := testsupport.UniqueAccountID(t)
	circleID := seedCircle(t, table)
	ask(t, store, circleID, joiner)
	member := circles.Member{AccountID: joiner, Role: circles.RoleMember, NotifyLevel: circles.NotifyAll}
	if err := store.ApproveRequest(ctx, circleID, "request-"+joiner, "admin", member,
		circles.SealedKeys{1: []byte("sealed-for-joiner")}, "Joiner", 1); err != nil {
		t.Fatal(err)
	}

	if err := store.DeleteRequest(ctx, circleID, "request-"+joiner); !errors.Is(err, circles.ErrRequestNotFound) {
		t.Fatalf("expected ErrRequestNotFound, got %v", err)
	}

	memberships, err := circleStore.ListMemberships(ctx, joiner)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 {
		t.Fatalf("the membership must be untouched, got %+v", memberships)
	}
}

func TestDeleteRequest_AnAskThatIsNotThere(t *testing.T) {
	table := testsupport.NewCircleTable(t)
	store := requests.NewStore(table)

	err := store.DeleteRequest(context.Background(), seedCircle(t, table), "request-nobody")
	if !errors.Is(err, circles.ErrRequestNotFound) {
		t.Fatalf("expected ErrRequestNotFound, got %v", err)
	}
}

// An admin who loaded the list just before the asker withdrew can still
// tap Approve. That must find nothing, not admit someone who took the
// ask back.
func TestDeleteRequest_ApprovingAWithdrawnAskFindsNothing(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, store := circle.NewStore(table), requests.NewStore(table)

	asker := testsupport.UniqueAccountID(t)
	circleID := seedCircle(t, table)
	ask(t, store, circleID, asker)
	if err := store.DeleteRequest(ctx, circleID, "request-"+asker); err != nil {
		t.Fatal(err)
	}

	member := circles.Member{AccountID: asker, Role: circles.RoleMember, NotifyLevel: circles.NotifyAll}
	err := store.ApproveRequest(ctx, circleID, "request-"+asker, "admin", member,
		circles.SealedKeys{1: []byte("sealed-for-asker")}, "Asker", 1)
	if !errors.Is(err, circles.ErrRequestNotFound) {
		t.Fatalf("expected ErrRequestNotFound, got %v", err)
	}
	memberships, err := circleStore.ListMemberships(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 0 {
		t.Fatalf("a withdrawn ask must not admit anyone, got %+v", memberships)
	}
}

// Withdrawing does not burn the code: the same account can ask again and
// is waiting again.
func TestDeleteRequest_AskingAgainAfterwardsWorks(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := requests.NewStore(table)

	asker := testsupport.UniqueAccountID(t)
	circleID := seedCircle(t, table)
	ask(t, store, circleID, asker)
	if err := store.DeleteRequest(ctx, circleID, "request-"+asker); err != nil {
		t.Fatal(err)
	}
	ask(t, store, circleID, asker)

	waiting, err := store.ListRequestsForAccount(ctx, asker)
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 1 || waiting[0].Status != circles.RequestPending {
		t.Fatalf("expected one pending ask again, got %+v", waiting)
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
