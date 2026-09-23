package circle_test

import (
	"context"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/util/testsupport"
)

// A cover change carries no name, and a rename carries no cover: each
// has to stand alone, and each records only what it changed.
func TestUpdateCircle_ChangesEitherFieldOnItsOwn(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := circle.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	founder := testsupport.UniqueAccountID(t)
	err := store.CreateCircle(ctx, circles.Circle{
		ID: circleID, Name: "Family", KeyVersion: 1, RosterVersion: 1, CreatedBy: founder, CreatedAt: time.Now(),
	}, circles.Member{AccountID: founder, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}

	// Cover alone. This is the one that used to fail: with no name in the
	// request there is nothing a reserved-word placeholder is needed for,
	// and DynamoDB rejects the empty map outright.
	updated, err := store.UpdateCircle(ctx, circleID, "", "cover-1", 1, founder)
	if err != nil {
		t.Fatal(err)
	}
	if updated.CoverID != "cover-1" || updated.CoverKeyVersion != 1 {
		t.Fatalf("coverId, coverKeyVersion = %q, %d, want cover-1, 1", updated.CoverID, updated.CoverKeyVersion)
	}
	if updated.Name != "Family" {
		t.Errorf("the name must be left alone, got %q", updated.Name)
	}

	// Name alone, then both at once.
	if updated, err = store.UpdateCircle(ctx, circleID, "Renamed", "", 0, founder); err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Renamed" || updated.CoverID != "cover-1" || updated.CoverKeyVersion != 1 {
		t.Fatalf("expected only the name to move, got %+v", updated)
	}

	if updated, err = store.UpdateCircle(ctx, circleID, "Both", "cover-2", 1, founder); err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Both" || updated.CoverID != "cover-2" || updated.CoverKeyVersion != 1 {
		t.Fatalf("expected both to move, got %+v", updated)
	}
}
