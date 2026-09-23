package erase_test

import (
	"context"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/comments"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/erase"
	"mimoza-relay/internal/circles/members"
	"mimoza-relay/internal/circles/posts"
	"mimoza-relay/internal/circles/reactions"
	"mimoza-relay/internal/circles/requests"
	"mimoza-relay/internal/util/testsupport"
)

// Deleting an account has to reach into every circle it was in. Until
// this existed the memberships, the sealed keys and everything the
// account wrote stayed behind, and it still counted against the member
// cap.
func TestAccount_LeavesNothingOfTheAccountInACircle(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)

	circleID := testsupport.UniqueCircleID(t)
	founder := testsupport.UniqueAccountID(t)
	leaver := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, founder)
	addMember(t, table, circleID, leaver, circles.RoleMember)

	// Two posts, one of them with a photo, a comment on the founder's
	// post, and a reaction to it.
	postStore := posts.NewStore(table)
	theirs, err := postStore.PutPost(ctx, circleID, circles.Entry{
		ID: "post-leaver", AuthorID: leaver, KeyVersion: 1, Ciphertext: []byte("mine"), HasBlob: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := postStore.PutPost(ctx, circleID, circles.Entry{
		ID: "post-founder", AuthorID: founder, KeyVersion: 1, Ciphertext: []byte("theirs"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := comments.NewStore(table).AddComment(ctx, circleID, circles.Comment{
		ID: "comment-1", PostID: "post-founder", AuthorID: leaver, KeyVersion: 1, Ciphertext: []byte("said"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := reactions.NewStore(table).SetReaction(ctx, circleID, circles.Reaction{
		AccountID: leaver, PostID: "post-founder", Tag: "heart", KeyVersion: 1, Ciphertext: []byte("h"),
	}); err != nil {
		t.Fatal(err)
	}

	erased, err := erase.NewStore(table).Account(ctx, leaver, "Ali")
	if err != nil {
		t.Fatal(err)
	}

	// The photo is named back to the caller, which is what deletes the
	// bytes the relay cannot.
	if len(erased.BlobKeys) != 1 || erased.BlobKeys[0] != circleID+"/"+theirs.ID {
		t.Errorf("blobKeys = %v, want the one photo", erased.BlobKeys)
	}

	// The membership and the sealed keys are gone.
	memberStore := members.NewStore(table)
	if _, err := memberStore.GetMember(ctx, circleID, leaver); err == nil {
		t.Error("expected the membership to be gone")
	}
	keys, err := memberStore.GetSealedKeys(ctx, circleID, leaver)
	if err == nil && len(keys) != 0 {
		t.Errorf("expected no sealed keys, got %v", keys)
	}

	// Their post is stripped but still there, so a walk delivers the
	// deletion rather than finding a hole.
	stripped, err := postStore.GetPost(ctx, circleID, "post-leaver", "")
	if err != nil {
		t.Fatal(err)
	}
	if stripped.DeletedAt.IsZero() || len(stripped.Ciphertext) != 0 {
		t.Errorf("expected a stripped post, got %+v", stripped)
	}

	// The founder's post keeps its ciphertext, and loses the comment and
	// the reaction the leaver left on it.
	host, err := postStore.GetPost(ctx, circleID, "post-founder", leaver)
	if err != nil {
		t.Fatal(err)
	}
	if len(host.Ciphertext) == 0 {
		t.Error("someone else's post must keep its content")
	}
	if host.CommentCount != 0 {
		t.Errorf("commentCount = %d, want 0", host.CommentCount)
	}
	if host.ReactionCounts["heart"] != 0 {
		t.Errorf("reactionCounts = %v, want the heart gone", host.ReactionCounts)
	}

	// The wall says an account was deleted, with the name, since the
	// profile it came from is about to go.
	page, err := postStore.ListEntries(ctx, circleID, founder, circles.Cursor{Type: circles.TypeActivity}, 50)
	if err != nil {
		t.Fatal(err)
	}
	var said bool
	for _, entry := range page.Entries {
		if entry.Event == circles.EventAccountDeleted && entry.SubjectName == "Ali" {
			said = true
		}
	}
	if !said {
		t.Error("expected an account_deleted activity carrying the name")
	}
}

// A circle needs someone who can run it. When the last admin deletes
// their account, nobody is left to promote anyone, so the relay does it.
func TestAccount_PromotesTheLongestStandingMember(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)

	circleID := testsupport.UniqueCircleID(t)
	admin := testsupport.UniqueAccountID(t)
	early := testsupport.UniqueAccountID(t)
	late := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, admin)
	addMemberAt(t, table, circleID, early, circles.RoleMember, time.Now().Add(-48*time.Hour))
	addMemberAt(t, table, circleID, late, circles.RoleMember, time.Now())

	if _, err := erase.NewStore(table).Account(ctx, admin, "Sarah"); err != nil {
		t.Fatal(err)
	}

	successor, err := members.NewStore(table).GetMember(ctx, circleID, early)
	if err != nil {
		t.Fatal(err)
	}
	if !successor.IsAdmin() {
		t.Errorf("expected the longest-standing member to inherit, got %+v", successor)
	}
	other, err := members.NewStore(table).GetMember(ctx, circleID, late)
	if err != nil {
		t.Fatal(err)
	}
	if other.IsAdmin() {
		t.Error("only one member should have been promoted")
	}
}

// A circle with nobody left in it is a circle nobody can read. It goes,
// and its blobs are named back so they can go too.
func TestAccount_TakesASoleMemberCircleWithIt(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)

	circleID := testsupport.UniqueCircleID(t)
	sole := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, sole)

	erased, err := erase.NewStore(table).Account(ctx, sole, "Sarah")
	if err != nil {
		t.Fatal(err)
	}
	if len(erased.Prefixes) != 1 || erased.Prefixes[0] != circleID+"/" {
		t.Errorf("prefixes = %v, want the circle's own", erased.Prefixes)
	}
	if _, err := circle.NewStore(table).GetCircle(ctx, circleID); err == nil {
		t.Error("expected the circle to be gone")
	}
}

// Deletion can be interrupted anywhere, so the client repeats it. The
// second run finds nothing left and says so by doing nothing.
func TestAccount_IsIdempotent(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)

	circleID := testsupport.UniqueCircleID(t)
	founder := testsupport.UniqueAccountID(t)
	leaver := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, founder)
	addMember(t, table, circleID, leaver, circles.RoleMember)

	store := erase.NewStore(table)
	if _, err := store.Account(ctx, leaver, "Ali"); err != nil {
		t.Fatal(err)
	}
	erased, err := store.Account(ctx, leaver, "Ali")
	if err != nil {
		t.Fatalf("a repeated deletion must be a no-op, got %v", err)
	}
	if len(erased.BlobKeys) != 0 || len(erased.Prefixes) != 0 {
		t.Errorf("expected nothing left to erase, got %+v", erased)
	}
	if _, err := store.Account(ctx, testsupport.UniqueAccountID(t), "Nobody"); err != nil {
		t.Errorf("deleting an account in no circles must be a no-op, got %v", err)
	}
}

// An ask to join a circle the account never got into goes too: it
// carries a public key nobody will seal to now.
func TestAccount_ForgetsPendingRequests(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)

	circleID := testsupport.UniqueCircleID(t)
	admin := testsupport.UniqueAccountID(t)
	asker := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, admin)

	requestStore := requests.NewStore(table)
	if err := requestStore.CreateRequest(ctx, circles.Request{
		ID:        circles.RequestID(asker),
		CircleID:  circleID,
		AccountID: asker,
		PublicKey: []byte("key"),
		Status:    circles.RequestPending,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := erase.NewStore(table).Account(ctx, asker, "Ali"); err != nil {
		t.Fatal(err)
	}

	pending, err := requestStore.ListRequests(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Errorf("expected the ask to be gone, got %+v", pending)
	}
}

func seedCircle(t *testing.T, table *dynamo.Table, circleID, founder string) {
	t.Helper()
	err := circle.NewStore(table).CreateCircle(context.Background(), circles.Circle{
		ID: circleID, Name: "Family", KeyVersion: 1, RosterVersion: 1, CreatedBy: founder, CreatedAt: time.Now(),
	}, circles.Member{AccountID: founder, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
}

func addMember(t *testing.T, table *dynamo.Table, circleID, accountID, role string) {
	t.Helper()
	addMemberAt(t, table, circleID, accountID, role, time.Now())
}

// addMemberAt admits someone the way approval does, with a joining time
// the test chooses: succession follows who has been there longest.
func addMemberAt(t *testing.T, table *dynamo.Table, circleID, accountID, role string, joined time.Time) {
	t.Helper()
	ctx := context.Background()
	store := requests.NewStore(table)

	request := circles.Request{
		ID:        circles.RequestID(accountID),
		CircleID:  circleID,
		AccountID: accountID,
		PublicKey: []byte("public-key"),
		Status:    circles.RequestPending,
		CreatedAt: joined,
		ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := store.CreateRequest(ctx, request); err != nil {
		t.Fatal(err)
	}
	err := store.ApproveRequest(ctx, circleID, request.ID, "system",
		circles.Member{AccountID: accountID, Role: role, NotifyLevel: circles.NotifyAll, JoinedAt: joined},
		circles.SealedKeys{1: []byte("sealed")}, "")
	if err != nil {
		t.Fatal(err)
	}
	waitForMember(t, table, circleID, accountID)
}

// waitForMember works around LocalStack, where a consistent GetItem sees
// a just-committed member while a consistent Query on the same partition
// sometimes does not. Real DynamoDB does not do this; without the wait
// the erasure reads a roster of one and deletes the circle, which turns
// every assertion below into a confusing failure.
func waitForMember(t *testing.T, table *dynamo.Table, circleID, accountID string) {
	t.Helper()
	for range 50 {
		roster, err := table.ListMembers(context.Background(), circleID)
		if err != nil {
			t.Fatal(err)
		}
		for _, member := range roster {
			if member.AccountID == accountID {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the member never appeared on the roster: %s", accountID)
}
