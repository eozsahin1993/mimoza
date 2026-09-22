package reactions_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/posts"
	"mimoza-relay/internal/circles/reactions"
	"mimoza-relay/internal/util/testsupport"
)

// A reaction is a slot, not an event: changing one adjusts both tags,
// and repeating one changes nothing. The counts on the post are what the
// wall renders, so they have to be exact however they are reached.
func TestSetReaction_MovesTheCountsBetweenTags(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	postStore, reactionStore := posts.NewStore(table), reactions.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	member := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, member)

	post, err := postStore.PutPost(ctx, circleID, circles.Entry{ID: "post-1", AuthorID: member, KeyVersion: 1, Ciphertext: []byte("x")})
	if err != nil {
		t.Fatal(err)
	}

	after, err := reactionStore.SetReaction(ctx, circleID, circles.Reaction{
		AccountID: member, PostID: post.ID, Tag: "heart", KeyVersion: 1, Ciphertext: []byte("h"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if after.ReactionCounts["heart"] != 1 {
		t.Fatalf("heart = %d, want 1", after.ReactionCounts["heart"])
	}
	if after.MyTag != "heart" {
		t.Errorf("myTag = %q, want heart", after.MyTag)
	}

	// The same tag again is a no-op, not a second count.
	if after, err = reactionStore.SetReaction(ctx, circleID, circles.Reaction{
		AccountID: member, PostID: post.ID, Tag: "heart", KeyVersion: 1, Ciphertext: []byte("h"),
	}); err != nil {
		t.Fatal(err)
	}
	if after.ReactionCounts["heart"] != 1 {
		t.Errorf("reacting twice with the same tag = %d, want 1", after.ReactionCounts["heart"])
	}

	// Changing tags moves the count rather than adding one.
	if after, err = reactionStore.SetReaction(ctx, circleID, circles.Reaction{
		AccountID: member, PostID: post.ID, Tag: "laugh", KeyVersion: 1, Ciphertext: []byte("l"),
	}); err != nil {
		t.Fatal(err)
	}
	if after.ReactionCounts["laugh"] != 1 || after.ReactionCounts["heart"] != 0 {
		t.Errorf("after changing tag: laugh=%d heart=%d, want 1 and 0",
			after.ReactionCounts["laugh"], after.ReactionCounts["heart"])
	}

	if after, err = reactionStore.ClearReaction(ctx, circleID, post.ID, member); err != nil {
		t.Fatal(err)
	}
	if after.ReactionCounts["laugh"] != 0 {
		t.Errorf("after clearing: laugh=%d, want 0", after.ReactionCounts["laugh"])
	}
	if after.MyTag != "" {
		t.Errorf("myTag = %q after clearing, want empty", after.MyTag)
	}
}

// Every member has their own slot, so their counts add up rather than
// overwrite each other.
func TestSetReaction_CountsEveryMemberSeparately(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	postStore, reactionStore := posts.NewStore(table), reactions.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	first := testsupport.UniqueAccountID(t)
	seedCircle(t, table, circleID, first)

	post, err := postStore.PutPost(ctx, circleID, circles.Entry{ID: "post-1", AuthorID: first, KeyVersion: 1, Ciphertext: []byte("x")})
	if err != nil {
		t.Fatal(err)
	}

	var last circles.Entry
	for i := range 3 {
		accountID := fmt.Sprintf("%s-%d", first, i)
		last, err = reactionStore.SetReaction(ctx, circleID, circles.Reaction{
			AccountID: accountID, PostID: post.ID, Tag: "heart", KeyVersion: 1, Ciphertext: []byte("h"),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if last.ReactionCounts["heart"] != 3 {
		t.Errorf("heart = %d, want 3", last.ReactionCounts["heart"])
	}

	// The post itself did not change, but its position in the forward
	// walk did, so a device that had passed it is handed it again.
	if !last.UpdatedAt.After(last.ReceivedAt) && !last.UpdatedAt.Equal(last.ReceivedAt) {
		t.Errorf("updatedAt %v should not predate receivedAt %v", last.UpdatedAt, last.ReceivedAt)
	}
}

// seedCircle puts the one row every write here checks for: the circle
// itself, with its key version.
func seedCircle(t *testing.T, table *dynamo.Table, circleID, founder string) {
	t.Helper()
	err := circle.NewStore(table).CreateCircle(context.Background(), circles.Circle{
		ID: circleID, Name: "test", KeyVersion: 1, RosterVersion: 1, CreatedBy: founder, CreatedAt: time.Now(),
	}, circles.Member{AccountID: founder, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
}
