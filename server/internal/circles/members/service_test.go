package members

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type fakeStore struct {
	members       map[string]circles.Member
	roster        []circles.Member
	removed       string
	left          string
	rewrapped     circles.SealedKeys
	setRole       func(ctx context.Context, circleID, accountID, role, actorID string) error
	setNotify     func(ctx context.Context, circleID, accountID, level string) error
	removeErr     error
	leaveErr      error
	replaceErr    error
	stampedName   string
	avatarID      string
	avatarVersion int64
	avatarErr     error
	getCircle     func(ctx context.Context, circleID string) (circles.Circle, error)
	sealedKeys    func(ctx context.Context, circleID, accountID string) (circles.SealedKeys, error)
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

func (f *fakeStore) SetRole(ctx context.Context, circleID, accountID, role, actorID, subjectName string) error {
	f.stampedName = subjectName
	if f.setRole == nil {
		return nil
	}
	return f.setRole(ctx, circleID, accountID, role, actorID)
}

func (f *fakeStore) SetAvatar(_ context.Context, _, _, avatarID string, keyVersion int64) error {
	f.avatarID, f.avatarVersion = avatarID, keyVersion
	return f.avatarErr
}

func (f *fakeStore) SetNotifyLevel(ctx context.Context, circleID, accountID, level string) error {
	if f.setNotify == nil {
		return nil
	}
	return f.setNotify(ctx, circleID, accountID, level)
}

func (f *fakeStore) RemoveMember(_ context.Context, _, accountID, _, subjectName string, _ int64, _ map[string][]byte) error {
	f.removed = accountID
	f.stampedName = subjectName
	return f.removeErr
}

func (f *fakeStore) LeaveCircle(_ context.Context, _, accountID, subjectName string) error {
	f.left = accountID
	f.stampedName = subjectName
	return f.leaveErr
}

func (f *fakeStore) ReplaceSealedKeys(_ context.Context, _, _ string, sealed circles.SealedKeys) error {
	f.rewrapped = sealed
	return f.replaceErr
}

// fakeProfiles is the accounts column: the circles column holds no
// names, so every test that reads a roster or writes an activity row
// goes through one of these.
type fakeProfiles struct {
	byID map[string]accounts.Profile
	err  error
}

func (f *fakeProfiles) GetProfile(_ context.Context, accountID string) (accounts.Profile, error) {
	if f.err != nil {
		return accounts.Profile{}, f.err
	}
	return f.byID[accountID], nil
}

func (f *fakeProfiles) GetProfiles(_ context.Context, accountIDs []string) (map[string]accounts.Profile, error) {
	if f.err != nil {
		return nil, f.err
	}
	found := make(map[string]accounts.Profile, len(accountIDs))
	for _, id := range accountIDs {
		if profile, ok := f.byID[id]; ok {
			found[id] = profile
		}
	}
	return found, nil
}

func named(names map[string]string) *fakeProfiles {
	byID := make(map[string]accounts.Profile, len(names))
	for id, name := range names {
		byID[id] = accounts.Profile{AccountID: id, Name: name, PublicKey: []byte(id + "-key")}
	}
	return &fakeProfiles{byID: byID}
}

func serviceFor(store *fakeStore, profiles *fakeProfiles) *Service {
	if profiles == nil {
		profiles = named(nil)
	}
	return &Service{Store: store, Profiles: profiles}
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
	service := serviceFor(store, nil)

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
	service := serviceFor(store, nil)

	if err := service.Leave(context.Background(), "circle-1", "admin-1"); err != nil {
		t.Fatal(err)
	}
	if store.left != "admin-1" {
		t.Error("expected the departure to reach the store")
	}
}

func TestLeave_AllowsAnAdminWhenAnotherRemains(t *testing.T) {
	store := roster(adminMember("admin-1"), adminMember("admin-2"))
	service := serviceFor(store, nil)

	if err := service.Leave(context.Background(), "circle-1", "admin-1"); err != nil {
		t.Fatal(err)
	}
}

// Demotion can strand a circle exactly as leaving can.
func TestSetRole_RefusesDemotingTheLastAdmin(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-2"))
	service := serviceFor(store, nil)

	err := service.SetRole(context.Background(), "circle-1", "admin-1", circles.RoleMember, "admin-1")
	if !errors.Is(err, circles.ErrWouldEmptyAdmins) {
		t.Errorf("expected ErrWouldEmptyAdmins, got %v", err)
	}
}

func TestSetRole_RefusesAMemberWhoIsNotAnAdmin(t *testing.T) {
	store := roster(plainMember("member-1"), plainMember("member-2"))
	service := serviceFor(store, nil)

	err := service.SetRole(context.Background(), "circle-1", "member-2", circles.RoleAdmin, "member-1")
	if !errors.Is(err, circles.ErrNotAdmin) {
		t.Errorf("expected ErrNotAdmin, got %v", err)
	}
}

// A notification level is a per-device preference, not something an
// admin sets for you.
func TestSetNotifyLevel_IsOnlyYourOwn(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-2"))
	service := serviceFor(store, nil)

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
	service := serviceFor(store, nil)

	err := service.Remove(context.Background(), "circle-1", "admin-1", "admin-1", 1, map[string][]byte{})
	if !errors.Is(err, circles.ErrNotTheAuthor) {
		t.Errorf("expected ErrNotTheAuthor, got %v", err)
	}
}

func TestRemove_RefusesANonAdmin(t *testing.T) {
	store := roster(plainMember("member-1"), plainMember("member-2"))
	service := serviceFor(store, nil)

	err := service.Remove(context.Background(), "circle-1", "member-2", "member-1", 1, map[string][]byte{})
	if !errors.Is(err, circles.ErrNotAdmin) {
		t.Errorf("expected ErrNotAdmin, got %v", err)
	}
}

// Resealing with nothing would clear a member's keys and lock them out
// of the circle they are still in.
func TestRewrap_RefusesAnEmptyKeySet(t *testing.T) {
	store := roster(plainMember("member-1"), plainMember("member-2"))
	service := serviceFor(store, nil)

	err := service.Rewrap(context.Background(), "circle-1", "member-2", "member-1", circles.SealedKeys{})
	if !errors.Is(err, circles.ErrIncompleteKeys) {
		t.Errorf("expected ErrIncompleteKeys, got %v", err)
	}
}

// Any member can reseal for another: they all hold the same keys, and
// the sealing happens on their own device.
func TestRewrap_IsOpenToAnyMember(t *testing.T) {
	store := roster(plainMember("member-1"), plainMember("member-2"))
	service := serviceFor(store, nil)

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
	service := serviceFor(store, nil)

	err := service.Rewrap(context.Background(), "circle-1", "member-2", "member-1", circles.SealedKeys{1: []byte("x")})
	if !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("expected ErrNotMember for the subject, got %v", err)
	}
}

// A roster is the circles column's memberships joined to the accounts
// column's people. Without the join it is a list of opaque ids, which no
// screen can render and no device can seal a key to.
func TestRoster_CarriesTheNameAndTheKeyBehindEachMember(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-2"))
	service := serviceFor(store, named(map[string]string{"admin-1": "Sarah", "member-2": "Ali"}))

	_, members, _, err := service.Roster(context.Background(), "circle-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 2 {
		t.Fatalf("expected both members, got %d", len(members))
	}
	byID := map[string]RosterMember{}
	for _, member := range members {
		byID[member.AccountID] = member
	}
	if byID["admin-1"].Name != "Sarah" || byID["member-2"].Name != "Ali" {
		t.Errorf("expected each member named, got %+v", members)
	}
	if string(byID["member-2"].PublicKey) != "member-2-key" {
		t.Errorf("expected the key a member seals to, got %q", byID["member-2"].PublicKey)
	}
	if !byID["admin-1"].IsAdmin() {
		t.Error("expected the membership to survive the join")
	}
}

// An account deleted between the two reads leaves a membership with
// nobody behind it. The membership is what decides who may read the
// circle, so it stays on the roster nameless rather than vanishing.
func TestRoster_KeepsAMemberWhoseProfileIsGone(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("ghost-2"))
	service := serviceFor(store, named(map[string]string{"admin-1": "Sarah"}))

	_, members, _, err := service.Roster(context.Background(), "circle-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 2 {
		t.Fatalf("expected both memberships, got %d", len(members))
	}
	for _, member := range members {
		if member.AccountID == "ghost-2" && member.Name != "" {
			t.Errorf("expected no name for a missing profile, got %q", member.Name)
		}
	}
}

// The accounts column being unreachable must not read as an empty
// roster: a device that believed it would seal keys to nobody.
func TestRoster_FailsRatherThanAnswerWithoutNames(t *testing.T) {
	store := roster(adminMember("admin-1"))
	service := serviceFor(store, &fakeProfiles{err: errors.New("dynamo is down")})

	if _, _, _, err := service.Roster(context.Background(), "circle-1", "admin-1"); err == nil {
		t.Fatal("expected the failure to reach the caller")
	}
}

// The wall has to say who left after they have gone, and a deleted
// account has no profile left to ask. So the name is copied onto the
// activity row as the change is written.
func TestDepartures_StampTheNameOnTheActivity(t *testing.T) {
	names := map[string]string{"admin-1": "Sarah", "member-2": "Ali"}

	t.Run("leaving", func(t *testing.T) {
		store := roster(adminMember("admin-1"), adminMember("member-2"))
		service := serviceFor(store, named(names))

		if err := service.Leave(context.Background(), "circle-1", "member-2"); err != nil {
			t.Fatal(err)
		}
		if store.stampedName != "Ali" {
			t.Errorf("stamped %q, want Ali", store.stampedName)
		}
	})

	t.Run("being removed", func(t *testing.T) {
		store := roster(adminMember("admin-1"), plainMember("member-2"))
		service := serviceFor(store, named(names))

		if err := service.Remove(context.Background(), "circle-1", "member-2", "admin-1", 1, nil); err != nil {
			t.Fatal(err)
		}
		if store.stampedName != "Ali" {
			t.Errorf("stamped %q, want Ali", store.stampedName)
		}
	})

	t.Run("a role change", func(t *testing.T) {
		store := roster(adminMember("admin-1"), plainMember("member-2"))
		service := serviceFor(store, named(names))

		if err := service.SetRole(context.Background(), "circle-1", "member-2", circles.RoleAdmin, "admin-1"); err != nil {
			t.Fatal(err)
		}
		if store.stampedName != "Ali" {
			t.Errorf("stamped %q, want Ali", store.stampedName)
		}
	})
}

// A name that cannot be read is worth less than the change itself: the
// removal still happens, the wall just says it with no name.
func TestDepartures_ProceedWhenTheNameCannotBeRead(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-2"))
	service := serviceFor(store, &fakeProfiles{err: errors.New("dynamo is down")})

	if err := service.Remove(context.Background(), "circle-1", "member-2", "admin-1", 1, nil); err != nil {
		t.Fatal(err)
	}
	if store.removed != "member-2" {
		t.Error("expected the removal to reach the store anyway")
	}
	if store.stampedName != "" {
		t.Errorf("expected no name, got %q", store.stampedName)
	}
}
