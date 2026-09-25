package comments_test

import (
	"context"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/comments"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/posts"
	"mimoza-relay/internal/util/testsupport"
)

// The author's own device applies the response the same way a sync does
// (docs/SYNC_DESIGN.md), so a comment that comes back saying ICommented:
// false would make the author's own comment look like someone else's
// until the next full sync — the same bug reactions/store_test.go proves
// does not happen on that path.
func TestAddComment_TheAuthorSeesTheyCommented(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	postStore, commentStore := posts.NewStore(table), comments.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	author := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, author)

	post, err := postStore.PutPost(ctx, circleID, circles.Entry{ID: "post-1", AuthorID: author, KeyVersion: 1, Ciphertext: []byte("x")})
	if err != nil {
		t.Fatal(err)
	}

	after, err := commentStore.AddComment(ctx, circleID, circles.Comment{
		ID: "comment-1", PostID: post.ID, AuthorID: author, KeyVersion: 1, Ciphertext: []byte("hi"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !after.ICommented {
		t.Error("expected the comment's own author to see ICommented on the post it just changed")
	}
}

func TestDeleteComment_TheDeletingAccountStillSeesItsOwnState(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	postStore, commentStore := posts.NewStore(table), comments.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	author := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, author)

	post, err := postStore.PutPost(ctx, circleID, circles.Entry{ID: "post-1", AuthorID: author, KeyVersion: 1, Ciphertext: []byte("x")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := commentStore.AddComment(ctx, circleID, circles.Comment{
		ID: "comment-1", PostID: post.ID, AuthorID: author, KeyVersion: 1, Ciphertext: []byte("hi"),
	}); err != nil {
		t.Fatal(err)
	}
	// A second comment survives the delete below, so ICommented should
	// still read true for the author afterward.
	if _, err := commentStore.AddComment(ctx, circleID, circles.Comment{
		ID: "comment-2", PostID: post.ID, AuthorID: author, KeyVersion: 1, Ciphertext: []byte("again"),
	}); err != nil {
		t.Fatal(err)
	}

	after, err := commentStore.DeleteComment(ctx, circleID, post.ID, "comment-1", author)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ICommented {
		t.Error("expected the deleting account to still see ICommented, having another comment on the post")
	}
}

func TestDeleteComment_MovesTheCirclesLastEntryAt(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	postStore, commentStore := posts.NewStore(table), comments.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	author := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, author)

	post, err := postStore.PutPost(ctx, circleID, circles.Entry{ID: "post-1", AuthorID: author, KeyVersion: 1, Ciphertext: []byte("x")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := commentStore.AddComment(ctx, circleID, circles.Comment{
		ID: "comment-1", PostID: post.ID, AuthorID: author, KeyVersion: 1, Ciphertext: []byte("hi"),
	}); err != nil {
		t.Fatal(err)
	}
	afterAdd, err := table.GetCircle(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}

	table.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := commentStore.DeleteComment(ctx, circleID, post.ID, "comment-1", author); err != nil {
		t.Fatal(err)
	}

	afterDelete, err := table.GetCircle(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}
	if !afterDelete.LastEntryAt.After(afterAdd.LastEntryAt) {
		t.Fatalf("lastEntryAt did not move on a comment delete: still %v (was %v)",
			afterDelete.LastEntryAt, afterAdd.LastEntryAt)
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
