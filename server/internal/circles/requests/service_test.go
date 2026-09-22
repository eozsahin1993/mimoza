package requests

import (
	"context"
	"errors"
	"testing"
	"time"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type fakeStore struct {
	invite   circles.Invite
	members  map[string]circles.Member
	created  circles.Request
	requests []circles.Request
	approved struct {
		requestID string
		member    circles.Member
		name      string
	}
}

func (f *fakeStore) GetCircle(_ context.Context, circleID string) (circles.Circle, error) {
	return circles.Circle{ID: circleID, KeyVersion: 1}, nil
}

func (f *fakeStore) GetMember(_ context.Context, _, accountID string) (circles.Member, error) {
	member, ok := f.members[accountID]
	if !ok {
		return circles.Member{}, circles.ErrNotMember
	}
	return member, nil
}

func (f *fakeStore) GetInvite(context.Context, string) (circles.Invite, error) {
	return f.invite, nil
}

func (f *fakeStore) CreateRequest(_ context.Context, request circles.Request) error {
	f.created = request
	return nil
}

func (f *fakeStore) ListRequests(context.Context, string) ([]circles.Request, error) {
	return f.requests, nil
}

func (f *fakeStore) ApproveRequest(_ context.Context, _, requestID, _ string, member circles.Member, _ circles.SealedKeys, name string) error {
	f.approved.requestID = requestID
	f.approved.member = member
	f.approved.name = name
	return nil
}

func (f *fakeStore) DenyRequest(context.Context, string, string) error { return nil }

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

func people(persons ...accounts.Profile) *fakeProfiles {
	byID := make(map[string]accounts.Profile, len(persons))
	for _, person := range persons {
		byID[person.AccountID] = person
	}
	return &fakeProfiles{byID: byID}
}

func person(accountID, name string) accounts.Profile {
	return accounts.Profile{
		AccountID: accountID,
		Name:      name,
		AvatarKey: "avatars/" + accountID,
		PublicKey: []byte(accountID + "-key"),
	}
}

// The key an approver seals the circle to is the one on the requester's
// account, not one the ask carries: the account is where that key lives,
// and a second copy is a second thing to go stale.
func TestCreate_SealsToTheKeyOnTheAccount(t *testing.T) {
	store := &fakeStore{invite: circles.Invite{CircleID: "circle-1", Code: "code"}}
	service := &Service{
		Store:     store,
		Profiles:  people(person("asker-1", "Sarah")),
		Retention: time.Hour,
	}

	request, err := service.Create(context.Background(), "code", "asker-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(request.PublicKey) != "asker-1-key" {
		t.Fatalf("expected the account's key, got %q", request.PublicKey)
	}
	if string(store.created.PublicKey) != "asker-1-key" {
		t.Errorf("expected the stored ask to carry it too, got %q", store.created.PublicKey)
	}
	if request.Status != circles.RequestPending {
		t.Errorf("status = %q, want pending", request.Status)
	}
}

// Admitting an account with no published key would admit someone who
// cannot read a word of the circle, and nobody would notice until they
// opened it.
func TestCreate_RefusesAnAccountWithNoPublishedKey(t *testing.T) {
	store := &fakeStore{invite: circles.Invite{CircleID: "circle-1", Code: "code"}}
	service := &Service{
		Store:     store,
		Profiles:  people(accounts.Profile{AccountID: "asker-1", Name: "Sarah"}),
		Retention: time.Hour,
	}

	_, err := service.Create(context.Background(), "code", "asker-1")
	if !errors.Is(err, circles.ErrNoPublicKey) {
		t.Fatalf("expected ErrNoPublicKey, got %v", err)
	}
	if store.created.ID != "" {
		t.Error("nothing should have been stored")
	}
}

// A member asking to join what they are already in is nothing for an
// admin to answer.
func TestCreate_RefusesAMemberAskingAgain(t *testing.T) {
	store := &fakeStore{
		invite:  circles.Invite{CircleID: "circle-1", Code: "code"},
		members: map[string]circles.Member{"asker-1": {AccountID: "asker-1", Role: circles.RoleMember}},
	}
	service := &Service{Store: store, Profiles: people(person("asker-1", "Sarah")), Retention: time.Hour}

	if _, err := service.Create(context.Background(), "code", "asker-1"); !errors.Is(err, circles.ErrAlreadyExists) {
		t.Fatalf("expected ErrAlreadyExists, got %v", err)
	}
}

// An admin answers a person, so the list carries who is asking rather
// than an account id alone.
func TestList_NamesWhoIsAsking(t *testing.T) {
	store := &fakeStore{
		members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}},
		requests: []circles.Request{
			{ID: "request-1", CircleID: "circle-1", AccountID: "asker-1", Status: circles.RequestPending},
			{ID: "request-2", CircleID: "circle-1", AccountID: "ghost-2", Status: circles.RequestPending},
		},
	}
	service := &Service{Store: store, Profiles: people(person("asker-1", "Sarah"))}

	pending, err := service.List(context.Background(), "circle-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 2 {
		t.Fatalf("expected both asks, got %d", len(pending))
	}
	if pending[0].Name != "Sarah" || pending[0].AvatarKey != "avatars/asker-1" {
		t.Errorf("expected the asker named, got %+v", pending[0])
	}
	// An account deleted between the two reads leaves the ask standing
	// with nobody behind it; an admin can still deny it.
	if pending[1].Name != "" || pending[1].ID != "request-2" {
		t.Errorf("expected a nameless ask to survive, got %+v", pending[1])
	}
}

// Only an admin sees who is waiting.
func TestList_RefusesAMemberWhoIsNotAnAdmin(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"member-1": {AccountID: "member-1", Role: circles.RoleMember}}}
	service := &Service{Store: store, Profiles: people()}

	if _, err := service.List(context.Background(), "circle-1", "member-1"); !errors.Is(err, circles.ErrNotAdmin) {
		t.Fatalf("expected ErrNotAdmin, got %v", err)
	}
}

// The joiner's name is stamped as they are admitted, so the wall can
// still say who joined after they have left again.
func TestApprove_StampsTheJoinerName(t *testing.T) {
	store := &fakeStore{
		members:  map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}},
		requests: []circles.Request{{ID: "request-1", CircleID: "circle-1", AccountID: "asker-1", Status: circles.RequestPending}},
	}
	service := &Service{Store: store, Profiles: people(person("asker-1", "Sarah"))}

	err := service.Approve(context.Background(), "circle-1", "request-1", "admin-1", circles.SealedKeys{1: []byte("sealed")})
	if err != nil {
		t.Fatal(err)
	}
	if store.approved.name != "Sarah" {
		t.Errorf("stamped %q, want Sarah", store.approved.name)
	}
	if store.approved.member.AccountID != "asker-1" || store.approved.member.Role != circles.RoleMember {
		t.Errorf("expected the asker admitted as a member, got %+v", store.approved.member)
	}
}
