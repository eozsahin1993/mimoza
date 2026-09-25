package posts_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/posts"
	"mimoza-relay/internal/util/testsupport"
)

// A client retries from its outbox, so a deletion arrives more than
// once. The second one must change nothing: restamping would move the
// post to the head of every device's forward walk, delivering a post
// nobody can read as though it were news.
func TestDeletePost_IsIdempotent(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := posts.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	author := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, author)

	if _, err := store.PutPost(ctx, circleID, circles.Entry{
		ID: "post-1", AuthorID: author, KeyVersion: 1, Ciphertext: []byte("caption"), HasBlob: true,
	}); err != nil {
		t.Fatal(err)
	}

	first, err := store.DeletePost(ctx, circleID, "post-1")
	if err != nil {
		t.Fatal(err)
	}
	if first.DeletedAt.IsZero() {
		t.Fatal("expected the post to be stamped deleted")
	}
	if len(first.Ciphertext) != 0 {
		t.Error("expected the ciphertext to be stripped")
	}

	// Far enough apart that a restamp would be unmistakable.
	table.Now = func() time.Time { return time.Now().Add(time.Hour) }

	second, err := store.DeletePost(ctx, circleID, "post-1")
	if err != nil {
		t.Fatalf("a repeated deletion must succeed: %v", err)
	}
	if !second.DeletedAt.Equal(first.DeletedAt) {
		t.Errorf("deletedAt moved: %v then %v", first.DeletedAt, second.DeletedAt)
	}
	if !second.UpdatedAt.Equal(first.UpdatedAt) {
		t.Errorf("updatedAt moved: %v then %v", first.UpdatedAt, second.UpdatedAt)
	}
}

// Other devices only walk a circle's posts when its lastEntryAt moves
// (see sync-circles.ts on the client) — so a delete that doesn't bump it
// is invisible to everyone but the deleter, however correctly the row
// itself was written.
func TestDeletePost_MovesTheCirclesLastEntryAt(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := posts.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	author := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, author)

	if _, err := store.PutPost(ctx, circleID, circles.Entry{
		ID: "post-1", AuthorID: author, KeyVersion: 1, Ciphertext: []byte("caption"),
	}); err != nil {
		t.Fatal(err)
	}
	afterPut, err := table.GetCircle(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}

	table.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := store.DeletePost(ctx, circleID, "post-1"); err != nil {
		t.Fatal(err)
	}

	afterDelete, err := table.GetCircle(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}
	if !afterDelete.LastEntryAt.After(afterPut.LastEntryAt) {
		t.Fatalf("lastEntryAt did not move on delete: still %v (was %v) — other members' sync would never walk this circle's posts and would keep the deleted post",
			afterDelete.LastEntryAt, afterPut.LastEntryAt)
	}
}

// Moving a post to or from the album is a write like any other that
// should reach every member's next walk.
func TestSetVisibility_MovesTheCirclesLastEntryAt(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := posts.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	author := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, author)

	if _, err := store.PutPost(ctx, circleID, circles.Entry{
		ID: "post-1", AuthorID: author, KeyVersion: 1, Ciphertext: []byte("caption"),
	}); err != nil {
		t.Fatal(err)
	}
	afterPut, err := table.GetCircle(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}

	table.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := store.SetVisibility(ctx, circleID, "post-1", "album"); err != nil {
		t.Fatal(err)
	}

	afterVisibility, err := table.GetCircle(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}
	if !afterVisibility.LastEntryAt.After(afterPut.LastEntryAt) {
		t.Fatalf("lastEntryAt did not move on a visibility change: still %v (was %v)",
			afterVisibility.LastEntryAt, afterPut.LastEntryAt)
	}
}

// A post that never existed is still nothing to delete.
func TestDeletePost_OnAPostThatWasNeverThere(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleID := testsupport.UniqueCircleID(t)
	seedCircle(t, table, circleID, testsupport.UniqueAccountID(t))

	_, err := posts.NewStore(table).DeletePost(ctx, circleID, "never-posted")
	if !errors.Is(err, circles.ErrEntryNotFound) {
		t.Fatalf("expected ErrEntryNotFound, got %v", err)
	}
}

// DynamoDB truncates a Query at 1 MB of items regardless of Limit, and
// hands back fewer rows than asked for along with a LastEvaluatedKey.
// More has to come from that key, not from whether the row count met
// Limit — a page this large would meet Limit only coincidentally, and a
// version keyed on the count alone would call this the end of the walk.
func TestListEntries_MoreSurvivesA1MBPageCutBelowTheLimit(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := posts.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	author := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, author)

	// 20 posts x 60 KB clears 1 MB well before either the post count or
	// any one item nears DynamoDB's own 400 KB item limit.
	big := make([]byte, 60*1024)
	for i := range 20 {
		id := fmt.Sprintf("post-%d", i)
		if _, err := store.PutPost(ctx, circleID, circles.Entry{
			ID: id, AuthorID: author, KeyVersion: 1, Ciphertext: big,
		}); err != nil {
			t.Fatal(err)
		}
	}

	page, err := store.ListEntries(ctx, circleID, "", circles.Cursor{Type: circles.TypePost}, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) >= 20 {
		t.Fatalf("expected the 1 MB cap to cut the page well short of all 20, got %d", len(page.Entries))
	}
	if !page.More {
		t.Fatalf("got %d of 20 entries under a limit of 200 — that gap is the 1 MB cap, not the end of the walk", len(page.Entries))
	}
}

func seedCircle(t *testing.T, table *dynamo.Table, circleID, founder string) {
	t.Helper()
	err := circle.NewStore(table).CreateCircle(context.Background(), circles.Circle{
		ID: circleID, Name: "test", KeyVersion: 1, RosterVersion: 1, CreatedBy: founder, CreatedAt: time.Now(),
	}, circles.Member{AccountID: founder, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
}
