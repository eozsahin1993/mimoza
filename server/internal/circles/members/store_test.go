package members_test

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

// The service checks the roster before writing, which two admins going
// at once can both pass. These assert the condition inside the write,
// which is what actually holds: they call the store directly, with no
// service check in front of it.
func TestStore_ACircleCannotBeLeftWithoutAnAdmin(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, memberStore := circle.NewStore(table), members.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	admin := testsupport.UniqueAccountID(t)
	other := admin + "-second"

	err := circleStore.CreateCircle(ctx, circles.Circle{
		ID: circleID, Name: "test", KeyVersion: 1, RosterVersion: 1, CreatedBy: admin, CreatedAt: time.Now(),
	}, circles.Member{AccountID: admin, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
	addMember(t, table, circleID, other)

	t.Run("the only admin cannot demote themselves while others remain", func(t *testing.T) {

		err := memberStore.SetRole(ctx, circleID, admin, circles.RoleMember, admin, "")
		if !errors.Is(err, circles.ErrWouldEmptyAdmins) {
			t.Fatalf("expected ErrWouldEmptyAdmins, got %v", err)
		}
		member, err := memberStore.GetMember(ctx, circleID, admin)
		if err != nil {
			t.Fatal(err)
		}
		if !member.IsAdmin() {
			t.Error("the demotion should not have landed")
		}
	})

	t.Run("nor leave", func(t *testing.T) {
		err := memberStore.LeaveCircle(ctx, circleID, admin, "", 1, map[string][]byte{other: []byte("sealed-v2")})
		if !errors.Is(err, circles.ErrWouldEmptyAdmins) {
			t.Fatalf("expected ErrWouldEmptyAdmins, got %v", err)
		}
	})

	t.Run("a stale version fails as itself, not as the admin guard", func(t *testing.T) {
		// other is not yet an admin, so this would also strand the circle —
		// the wrong version has to be what comes back regardless.
		err := memberStore.LeaveCircle(ctx, circleID, admin, "", 99, map[string][]byte{other: []byte("sealed-v2")})
		if !errors.Is(err, circles.ErrVersionMoved) {
			t.Fatalf("expected ErrVersionMoved, got %v", err)
		}
	})

	t.Run("but may once someone else is an admin", func(t *testing.T) {
		if err := memberStore.SetRole(ctx, circleID, other, circles.RoleAdmin, admin, ""); err != nil {
			t.Fatal(err)
		}
		if err := memberStore.LeaveCircle(ctx, circleID, admin, "", 1, map[string][]byte{other: []byte("sealed-v2")}); err != nil {
			t.Fatalf("leaving with another admin in place: %v", err)
		}

		circle, err := memberStore.GetCircle(ctx, circleID)
		if err != nil {
			t.Fatal(err)
		}
		if circle.KeyVersion != 2 {
			t.Fatalf("expected the key to have rotated to version 2, got %d", circle.KeyVersion)
		}
		sealed, err := memberStore.GetSealedKeys(ctx, circleID, other)
		if err != nil {
			t.Fatal(err)
		}
		if string(sealed[2]) != "sealed-v2" {
			t.Fatalf("expected other's sealed keys to carry version 2, got %+v", sealed)
		}
	})

	t.Run("and the last member out strands nobody", func(t *testing.T) {
		if err := memberStore.LeaveCircle(ctx, circleID, other, "", 2, map[string][]byte{}); err != nil {
			t.Fatalf("the last member leaving: %v", err)
		}
	})
}

// A kick writes an activity entry the same as a leave does, so it should
// move meta.LastEntryAt the same way TestStore_ACircleCannotBeLeftWithoutAnAdmin
// already shows LeaveCircle does — otherwise a circle whose only recent
// event is a removal sorts as if nothing happened.
func TestStore_RemoveMemberBumpsLastEntryAt(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, memberStore := circle.NewStore(table), members.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	admin := testsupport.UniqueAccountID(t)
	other := admin + "-second"

	if err := circleStore.CreateCircle(ctx, circles.Circle{
		ID: circleID, Name: "test", KeyVersion: 1, RosterVersion: 1, CreatedBy: admin, CreatedAt: time.Now(),
	}, circles.Member{AccountID: admin, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed")); err != nil {
		t.Fatal(err)
	}
	addMember(t, table, circleID, other)

	before, err := memberStore.GetCircle(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}

	if err := memberStore.RemoveMember(ctx, circleID, other, admin, "Other", 1, map[string][]byte{admin: []byte("sealed-v2")}); err != nil {
		t.Fatalf("removing the member: %v", err)
	}

	after, err := memberStore.GetCircle(ctx, circleID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.LastEntryAt.After(before.LastEntryAt) {
		t.Fatalf("expected LastEntryAt to move forward on a kick, stayed at %v", after.LastEntryAt)
	}
}

// A rewrap is computed from whatever versions the rewrapping device knew
// about when it fetched the roster — if a kick rotates the circle again
// before the rewrap lands, the survivor loop has already added that new
// version to this same account's key item. Replacing the whole item
// would throw that version away with nothing to flag the loss; only the
// versions the rewrap actually recomputed should move.
func TestStore_RewrapDoesNotDropAVersionAddedByAConcurrentKick(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, memberStore := circle.NewStore(table), members.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	admin := testsupport.UniqueAccountID(t)
	b, c, d := admin+"-b", admin+"-c", admin+"-d"

	if err := circleStore.CreateCircle(ctx, circles.Circle{
		ID: circleID, Name: "test", KeyVersion: 1, RosterVersion: 1, CreatedBy: admin, CreatedAt: time.Now(),
	}, circles.Member{AccountID: admin, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed")); err != nil {
		t.Fatal(err)
	}
	addMember(t, table, circleID, b)
	addMember(t, table, circleID, c)
	addMember(t, table, circleID, d)

	// Rotates to v2: b and c each pick up a v2 sealed key alongside the
	// v1 they already held from joining.
	if err := memberStore.RemoveMember(ctx, circleID, d, admin, "D", 1,
		map[string][]byte{admin: []byte("admin-v2"), b: []byte("b-v2"), c: []byte("c-v2")}); err != nil {
		t.Fatalf("kicking d: %v", err)
	}

	// b's rewrap is now in flight, computed from what it knew at v2:
	// versions 1 and 2 only.
	bsRewrap := circles.SealedKeys{1: []byte("b-new-v1"), 2: []byte("b-new-v2")}

	// Before that rewrap lands, a second kick rotates to v3 — b survives
	// and its key item picks up v3 via the per-survivor merge, same as
	// any other still-current member.
	if err := memberStore.RemoveMember(ctx, circleID, c, admin, "C", 2,
		map[string][]byte{admin: []byte("admin-v3"), b: []byte("b-v3")}); err != nil {
		t.Fatalf("kicking c: %v", err)
	}

	if err := memberStore.ReplaceSealedKeys(ctx, circleID, b, bsRewrap); err != nil {
		t.Fatalf("replacing b's sealed keys: %v", err)
	}

	got, err := memberStore.GetSealedKeys(ctx, circleID, b)
	if err != nil {
		t.Fatal(err)
	}
	if string(got[3]) != "b-v3" {
		t.Fatalf("expected version 3 (added by the concurrent kick) to survive the rewrap, got %+v", got)
	}
	if string(got[1]) != "b-new-v1" || string(got[2]) != "b-new-v2" {
		t.Fatalf("expected versions 1 and 2 to carry the rewrap's own new seals, got %+v", got)
	}
}

// The new key must cover every member staying behind — a leave that
// forgets one would lock them out of everything posted after it.
func TestStore_LeaveRefusesAnIncompleteKeySet(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewCircleTable(t)
	circleStore, memberStore := circle.NewStore(table), members.NewStore(table)

	circleID := testsupport.UniqueCircleID(t)
	admin := testsupport.UniqueAccountID(t)
	other := admin + "-second"

	err := circleStore.CreateCircle(ctx, circles.Circle{
		ID: circleID, Name: "test", KeyVersion: 1, RosterVersion: 1, CreatedBy: admin, CreatedAt: time.Now(),
	}, circles.Member{AccountID: admin, Role: circles.RoleAdmin, NotifyLevel: circles.NotifyAll}, []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
	addMember(t, table, circleID, other)
	third := other + "-third"
	addMember(t, table, circleID, third)

	err = memberStore.LeaveCircle(ctx, circleID, admin, "", 1, map[string][]byte{other: []byte("sealed-v2")})
	if !errors.Is(err, circles.ErrIncompleteKeys) {
		t.Fatalf("expected ErrIncompleteKeys, got %v", err)
	}
	if _, err := memberStore.GetMember(ctx, circleID, admin); err != nil {
		t.Fatalf("the leave must not have landed: %v", err)
	}
}

// addMember admits someone the way the relay does, through a request and
// its approval: a membership and its sealed keys are written together,
// and there is no shortcut past that.
func addMember(t *testing.T, table *dynamo.Table, circleID, accountID string) {
	t.Helper()
	ctx := context.Background()
	store := requests.NewStore(table)

	request := circles.Request{
		ID:        "request-" + accountID,
		CircleID:  circleID,
		AccountID: accountID,
		PublicKey: []byte("public-key"),
		Status:    circles.RequestPending,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := store.CreateRequest(ctx, request); err != nil {
		t.Fatal(err)
	}
	member := circles.Member{AccountID: accountID, Role: circles.RoleMember, NotifyLevel: circles.NotifyAll}
	if err := store.ApproveRequest(ctx, circleID, request.ID, "admin", member, circles.SealedKeys{1: []byte("sealed")}, "", 1); err != nil {
		t.Fatal(err)
	}
}
