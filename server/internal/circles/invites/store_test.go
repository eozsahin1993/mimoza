package invites_test

import (
	"context"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/circle"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/invites"
	"mimoza-relay/internal/util/testsupport"
)

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

// A code is written twice — under its circle, and under itself — so it
// can be opened by someone who does not yet know which circle it
// belongs to. Both have to agree, or a link would resolve to nothing.
func TestStore_AnInviteIsWrittenAndReadBack(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := invites.NewStore(table)
	circleID := seedCircle(t, table)
	admin := testsupport.UniqueAccountID(t)

	invite := circles.Invite{
		Code: testsupport.UniqueInviteTag(t), CircleID: circleID, CreatedBy: admin,
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := store.CreateInvite(ctx, invite); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetInvite(ctx, invite.Code)
	if err != nil {
		t.Fatal(err)
	}
	if got.CircleID != circleID || got.CreatedBy != admin {
		t.Fatalf("expected the invite read back, got %+v", got)
	}
}

func TestStore_GetInvite_UnknownCodeIsNotFound(t *testing.T) {
	store := invites.NewStore(testsupport.NewCircleTable(t))
	if _, err := store.GetInvite(context.Background(), "no-such-code"); err != circles.ErrInviteNotFound {
		t.Fatalf("expected ErrInviteNotFound, got %v", err)
	}
}

// TTL sweeps an expired row eventually, not the instant it expires, so
// the expiry has to be checked on read rather than trusted to it —
// otherwise a code would keep working for however long the sweep takes.
func TestStore_AnExpiredInviteIsNotFound(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := invites.NewStore(table)
	circleID := seedCircle(t, table)

	invite := circles.Invite{
		Code: testsupport.UniqueInviteTag(t), CircleID: circleID, CreatedBy: testsupport.UniqueAccountID(t),
		CreatedAt: time.Now().Add(-2 * time.Hour), ExpiresAt: time.Now().Add(-time.Hour),
	}
	if err := store.CreateInvite(ctx, invite); err != nil {
		t.Fatal(err)
	}

	if _, err := store.GetInvite(ctx, invite.Code); err != circles.ErrInviteNotFound {
		t.Fatalf("expected an expired code to read as not found, got %v", err)
	}
	live, err := store.ListInvites(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 0 {
		t.Errorf("expected an expired invite to be left out of the list, got %+v", live)
	}
}

func TestStore_ListInvitesReturnsOnlyThisCirclesLiveOnes(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := invites.NewStore(table)
	mine := seedCircle(t, table)
	theirs := seedCircle(t, table)

	for _, circleID := range []string{mine, mine, theirs} {
		invite := circles.Invite{
			Code: testsupport.UniqueInviteTag(t), CircleID: circleID, CreatedBy: testsupport.UniqueAccountID(t),
			CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
		}
		if err := store.CreateInvite(ctx, invite); err != nil {
			t.Fatal(err)
		}
	}

	live, err := store.ListInvites(ctx, mine)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 2 {
		t.Fatalf("expected only this circle's two invites, got %d", len(live))
	}
	for _, invite := range live {
		if invite.CircleID != mine {
			t.Errorf("expected every invite scoped to %s, got %+v", mine, invite)
		}
	}
}

// Revoking removes both rows: the circle can no longer list it, and the
// code itself no longer resolves — a half-revoke, leaving the lookup row
// behind, would let a held link keep working.
func TestStore_RevokeRemovesBothRows(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := invites.NewStore(table)
	circleID := seedCircle(t, table)

	invite := circles.Invite{
		Code: testsupport.UniqueInviteTag(t), CircleID: circleID, CreatedBy: testsupport.UniqueAccountID(t),
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := store.CreateInvite(ctx, invite); err != nil {
		t.Fatal(err)
	}

	if err := store.RevokeInvite(ctx, circleID, invite.Code); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetInvite(ctx, invite.Code); err != circles.ErrInviteNotFound {
		t.Fatalf("expected the code to stop resolving, got %v", err)
	}
	live, err := store.ListInvites(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 0 {
		t.Errorf("expected the circle's list to lose it too, got %+v", live)
	}
}

// A code is scoped to the circle that made it: revoking one that
// belongs to another circle, or never existed at all, is refused rather
// than silently doing nothing — otherwise an admin of one circle could
// kill another circle's live invite just by guessing or being handed
// its code.
func TestStore_RevokeRefusesACodeThatIsNotThisCirclesOwn(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	store := invites.NewStore(table)
	mine := seedCircle(t, table)
	theirs := seedCircle(t, table)

	if err := store.RevokeInvite(ctx, mine, "never-existed"); err != circles.ErrInviteNotFound {
		t.Fatalf("an unknown code: expected ErrInviteNotFound, got %v", err)
	}

	invite := circles.Invite{
		Code: testsupport.UniqueInviteTag(t), CircleID: theirs, CreatedBy: testsupport.UniqueAccountID(t),
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := store.CreateInvite(ctx, invite); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeInvite(ctx, mine, invite.Code); err != circles.ErrInviteNotFound {
		t.Fatalf("someone else's code: expected ErrInviteNotFound, got %v", err)
	}
	// Untouched: still resolves, since the revoke against the wrong
	// circle must not have taken anything with it.
	if _, err := store.GetInvite(ctx, invite.Code); err != nil {
		t.Errorf("expected the real owner's code to survive, got %v", err)
	}
}
