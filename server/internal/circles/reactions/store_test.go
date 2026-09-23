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

// A member may hold several reactions at once, and repeating one changes
// nothing. The counts on the post are what the wall renders, so they have
// to be exact however they are reached.
func TestReactions_AMemberMayHoldSeveral(t *testing.T) {
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

	react := func(tag string) circles.Entry {
		t.Helper()
		after, err := reactionStore.Add(ctx, circleID, circles.Reaction{
			AccountID: member, PostID: post.ID, Tag: tag, KeyVersion: 1, Ciphertext: []byte(tag),
		})
		if err != nil {
			t.Fatal(err)
		}
		return after
	}

	after := react("heart")
	if after.ReactionCounts["heart"] != 1 {
		t.Fatalf("heart = %d, want 1", after.ReactionCounts["heart"])
	}
	if !after.IReacted {
		t.Error("expected the caller to be marked as having reacted")
	}

	// The same emoji again is the same row, not a second count.
	if after = react("heart"); after.ReactionCounts["heart"] != 1 {
		t.Errorf("reacting twice with the same tag = %d, want 1", after.ReactionCounts["heart"])
	}

	// A second emoji stands beside the first rather than replacing it.
	after = react("laugh")
	if after.ReactionCounts["heart"] != 1 || after.ReactionCounts["laugh"] != 1 {
		t.Fatalf("heart=%d laugh=%d, want 1 and 1",
			after.ReactionCounts["heart"], after.ReactionCounts["laugh"])
	}

	// Taking one back leaves the other, and the flag stays set.
	after, err = reactionStore.Remove(ctx, circleID, post.ID, member, "heart")
	if err != nil {
		t.Fatal(err)
	}
	if _, held := after.ReactionCounts["heart"]; held {
		t.Errorf("heart should be gone from the counts, got %v", after.ReactionCounts)
	}
	if after.ReactionCounts["laugh"] != 1 {
		t.Errorf("laugh = %d, want 1", after.ReactionCounts["laugh"])
	}
	if !after.IReacted {
		t.Error("one reaction remains, so the flag stays set")
	}

	// Taking the last one back clears it.
	if after, err = reactionStore.Remove(ctx, circleID, post.ID, member, "laugh"); err != nil {
		t.Fatal(err)
	}
	if after.IReacted {
		t.Error("expected the flag to come off with the last reaction")
	}

	// Taking back something that was never there changes nothing.
	if _, err := reactionStore.Remove(ctx, circleID, post.ID, member, "heart"); err != nil {
		t.Fatalf("removing a reaction that is not there: %v", err)
	}
}

// Every member's reactions count separately, so they add up rather than
// overwrite each other.
func TestReactions_CountEveryMemberSeparately(t *testing.T) {
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
		last, err = reactionStore.Add(ctx, circleID, circles.Reaction{
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
