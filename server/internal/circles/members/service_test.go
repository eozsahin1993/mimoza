package members

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/circles"
)

type fakeStore struct {
	members    map[string]circles.Member
	roster     []circles.Member
	removed    string
	left       string
	rewrapped  circles.SealedKeys
	setRole    func(ctx context.Context, circleID, accountID, role, actorID string) error
	setNotify  func(ctx context.Context, circleID, accountID, level string) error
	removeErr  error
	leaveErr   error
	replaceErr error
	getCircle  func(ctx context.Context, circleID string) (circles.Circle, error)
	sealedKeys func(ctx context.Context, circleID, accountID string) (circles.SealedKeys, error)
}

func (f *fakeStore) GetCircle(ctx context.Context, circleID string) (circles.Circle, error) {
	if f.getCircle == nil {
		return circles.Circle{ID: circleID, KeyVersion: 1}, nil
	}
	return f.getCircle(ctx, circleID)
}

func (f *fakeStore) GetMember(_ context.Context, _, accountID string) (circles.Member, error) {
	member, ok := f.members[accountID]
	if !ok {
		return circles.Member{}, circles.ErrNotMember
	}
	return member, nil
}

func (f *fakeStore) ListMembers(context.Context, string) ([]circles.Member, error) {
	return f.roster, nil
}

func (f *fakeStore) GetSealedKeys(ctx context.Context, circleID, accountID string) (circles.SealedKeys, error) {
	if f.sealedKeys == nil {
		return circles.SealedKeys{}, nil
	}
	return f.sealedKeys(ctx, circleID, accountID)
}

func (f *fakeStore) SetRole(ctx context.Context, circleID, accountID, role, actorID string) error {
	if f.setRole == nil {
		return nil
	}
	return f.setRole(ctx, circleID, accountID, role, actorID)
}

func (f *fakeStore) SetNotifyLevel(ctx context.Context, circleID, accountID, level string) error {
	if f.setNotify == nil {
		return nil
	}
	return f.setNotify(ctx, circleID, accountID, level)
}

func (f *fakeStore) RemoveMember(_ context.Context, _, accountID, _ string, _ int64, _ map[string][]byte) error {
	f.removed = accountID
	return f.removeErr
}

func (f *fakeStore) LeaveCircle(_ context.Context, _, accountID string) error {
	f.left = accountID
	return f.leaveErr
}

func (f *fakeStore) ReplaceSealedKeys(_ context.Context, _, _ string, sealed circles.SealedKeys) error {
	f.rewrapped = sealed
	return f.replaceErr
}

func roster(members ...circles.Member) *fakeStore {
	byID := map[string]circles.Member{}
	for _, member := range members {
		byID[member.AccountID] = member
	}
	return &fakeStore{members: byID, roster: members}
}

func adminMember(id string) circles.Member {
	return circles.Member{AccountID: id, Role: circles.RoleAdmin}
}

func plainMember(id string) circles.Member {
	return circles.Member{AccountID: id, Role: circles.RoleMember}
}

// The guard that keeps a circle governable: the last admin has to hand
// the role on before going, or nobody could ever rotate a key, admit
// anyone, or remove anyone again.
func TestLeave_RefusesTheLastAdminWhileOthersRemain(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-2"))
	service := &Service{Store: store}

	if err := service.Leave(context.Background(), "circle-1", "admin-1"); !errors.Is(err, circles.ErrWouldEmptyAdmins) {
		t.Fatalf("expected ErrWouldEmptyAdmins, got %v", err)
	}
	if store.left != "" {
		t.Error("the departure should not have reached the store")
	}
}

// The same rule, the other way round: an admin alone in a circle is free
// to go, since there is nobody left to strand.
func TestLeave_AllowsTheLastAdminWhenNobodyElseIsLeft(t *testing.T) {
	store := roster(adminMember("admin-1"))
	service := &Service{Store: store}

	if err := service.Leave(context.Background(), "circle-1", "admin-1"); err != nil {
		t.Fatal(err)
	}
	if store.left != "admin-1" {
		t.Error("expected the departure to reach the store")
	}
}

func TestLeave_AllowsAnAdminWhenAnotherRemains(t *testing.T) {
	store := roster(adminMember("admin-1"), adminMember("admin-2"))
	service := &Service{Store: store}

	if err := service.Leave(context.Background(), "circle-1", "admin-1"); err != nil {
		t.Fatal(err)
	}
}

// Demotion can strand a circle exactly as leaving can.
func TestSetRole_RefusesDemotingTheLastAdmin(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-2"))
	service := &Service{Store: store}

	err := service.SetRole(context.Background(), "circle-1", "admin-1", circles.RoleMember, "admin-1")
	if !errors.Is(err, circles.ErrWouldEmptyAdmins) {
		t.Errorf("expected ErrWouldEmptyAdmins, got %v", err)
	}
}

func TestSetRole_RefusesAMemberWhoIsNotAnAdmin(t *testing.T) {
	store := roster(plainMember("member-1"), plainMember("member-2"))
	service := &Service{Store: store}

	err := service.SetRole(context.Background(), "circle-1", "member-2", circles.RoleAdmin, "member-1")
	if !errors.Is(err, circles.ErrNotAdmin) {
		t.Errorf("expected ErrNotAdmin, got %v", err)
	}
}

// A notification level is a per-device preference, not something an
// admin sets for you.
func TestSetNotifyLevel_IsOnlyYourOwn(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-2"))
	service := &Service{Store: store}

	err := service.SetNotifyLevel(context.Background(), "circle-1", "member-2", circles.NotifyNone, "admin-1")
	if !errors.Is(err, circles.ErrNotTheAuthor) {
		t.Errorf("an admin setting someone else's level: expected ErrNotTheAuthor, got %v", err)
	}
	if err := service.SetNotifyLevel(context.Background(), "circle-1", "member-2", circles.NotifyNone, "member-2"); err != nil {
		t.Errorf("setting your own level: %v", err)
	}
}

// Removing yourself is leaving, which does not rotate the key — sending
// it down the removal path would churn everyone else's keys for nothing.
func TestRemove_RefusesRemovingYourself(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-2"))
	service := &Service{Store: store}

	err := service.Remove(context.Background(), "circle-1", "admin-1", "admin-1", 1, map[string][]byte{})
	if !errors.Is(err, circles.ErrNotTheAuthor) {
		t.Errorf("expected ErrNotTheAuthor, got %v", err)
	}
}

func TestRemove_RefusesANonAdmin(t *testing.T) {
	store := roster(plainMember("member-1"), plainMember("member-2"))
	service := &Service{Store: store}

	err := service.Remove(context.Background(), "circle-1", "member-2", "member-1", 1, map[string][]byte{})
	if !errors.Is(err, circles.ErrNotAdmin) {
		t.Errorf("expected ErrNotAdmin, got %v", err)
	}
}

// Resealing with nothing would clear a member's keys and lock them out
// of the circle they are still in.
func TestRewrap_RefusesAnEmptyKeySet(t *testing.T) {
	store := roster(plainMember("member-1"), plainMember("member-2"))
	service := &Service{Store: store}

	err := service.Rewrap(context.Background(), "circle-1", "member-2", "member-1", circles.SealedKeys{})
	if !errors.Is(err, circles.ErrIncompleteKeys) {
		t.Errorf("expected ErrIncompleteKeys, got %v", err)
	}
}

// Any member can reseal for another: they all hold the same keys, and
// the sealing happens on their own device.
func TestRewrap_IsOpenToAnyMember(t *testing.T) {
	store := roster(plainMember("member-1"), plainMember("member-2"))
	service := &Service{Store: store}

	sealed := circles.SealedKeys{1: []byte("sealed")}
	if err := service.Rewrap(context.Background(), "circle-1", "member-2", "member-1", sealed); err != nil {
		t.Fatal(err)
	}
	if len(store.rewrapped) != 1 {
		t.Errorf("store got %d keys, want 1", len(store.rewrapped))
	}
}

func TestRewrap_RefusesAStranger(t *testing.T) {
	store := roster(plainMember("member-1"))
	service := &Service{Store: store}

	err := service.Rewrap(context.Background(), "circle-1", "member-2", "member-1", circles.SealedKeys{1: []byte("x")})
	if !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("expected ErrNotMember for the subject, got %v", err)
	}
}
