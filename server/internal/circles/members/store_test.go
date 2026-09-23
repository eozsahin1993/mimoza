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
	if err := store.ApproveRequest(ctx, circleID, request.ID, "admin", member, circles.SealedKeys{1: []byte("sealed")}, ""); err != nil {
		t.Fatal(err)
	}
}
