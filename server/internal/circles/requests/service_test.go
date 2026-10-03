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
	denied   string
	deleted  struct{ circleID, requestID string }
	// deleteErr is what a withdrawal answers with, for the ask that is
	// no longer open.
	deleteErr error
	approved  struct {
		requestID       string
		member          circles.Member
		name            string
		expectedVersion int64
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

func (f *fakeStore) ListMembers(context.Context, string) ([]circles.Member, error) {
	roster := make([]circles.Member, 0, len(f.members))
	for _, member := range f.members {
		roster = append(roster, member)
	}
	return roster, nil
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

func (f *fakeStore) ApproveRequest(_ context.Context, _, requestID, _ string, member circles.Member, _ circles.SealedKeys, name string, expectedVersion int64) error {
	f.approved.requestID = requestID
	f.approved.member = member
	f.approved.name = name
	f.approved.expectedVersion = expectedVersion
	return nil
}

func (f *fakeStore) DenyRequest(_ context.Context, _, requestID string) error {
	f.denied = requestID
	return nil
}

func (f *fakeStore) DeleteRequest(_ context.Context, circleID, requestID string) error {
	f.deleted.circleID = circleID
	f.deleted.requestID = requestID
	return f.deleteErr
}

type fakeNotifier struct{ sent []circles.Notification }

func (f *fakeNotifier) Notify(_ context.Context, event circles.Notification) {
	f.sent = append(f.sent, event)
}

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
		PublicKey: []byte(accountID + "-key"),
	}
}

type fakeBucket struct{ key string }

func (f *fakeBucket) DownloadURL(_ context.Context, key string) (string, error) {
	f.key = key
	return "https://cdn.example/" + key, nil
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

// A tap on the notification needs the request's own id to tell whether
// it's still the one waiting — another admin may have already answered
// it by the time this one opens the app.
func TestCreate_NotifiesAdminsWithTheRequestID(t *testing.T) {
	store := &fakeStore{
		invite:  circles.Invite{CircleID: "circle-1", Code: "code"},
		members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}},
	}
	notifier := &fakeNotifier{}
	service := &Service{
		Store:     store,
		Profiles:  people(person("asker-1", "Sarah")),
		Notify:    notifier,
		Retention: time.Hour,
	}

	request, err := service.Create(context.Background(), "code", "asker-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(notifier.sent) != 1 {
		t.Fatalf("expected one notification, got %d", len(notifier.sent))
	}
	sent := notifier.sent[0]
	if sent.RequestID != request.ID {
		t.Errorf("RequestID = %q, want the request's own id %q", sent.RequestID, request.ID)
	}
	if sent.Kind != circles.NotifyJoinRequest || sent.CircleID != "circle-1" || sent.ActorID != "asker-1" {
		t.Errorf("unexpected notification shape: %+v", sent)
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
// than an account id alone — a name, and a picture already signed, since
// an admin reviewing the list is going to look at every row.
func TestList_NamesWhoIsAsking(t *testing.T) {
	asker := person("asker-1", "Sarah")
	asker.ProfilePictureID = "pic-1"
	store := &fakeStore{
		members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}},
		requests: []circles.Request{
			{ID: "request-1", CircleID: "circle-1", AccountID: "asker-1", Status: circles.RequestPending},
			{ID: "request-2", CircleID: "circle-1", AccountID: "ghost-2", Status: circles.RequestPending},
		},
	}
	bucket := &fakeBucket{}
	service := &Service{Store: store, Profiles: people(asker), Blobs: bucket}

	pending, err := service.List(context.Background(), "circle-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 2 {
		t.Fatalf("expected both asks, got %d", len(pending))
	}
	if pending[0].Name != "Sarah" {
		t.Errorf("expected the asker named, got %+v", pending[0])
	}
	if pending[0].ProfilePictureURL != "https://cdn.example/account/asker-1/picture/pic-1" {
		t.Errorf("url = %q", pending[0].ProfilePictureURL)
	}
	// An account deleted between the two reads leaves the ask standing
	// with nobody behind it; an admin can still deny it.
	if pending[1].Name != "" || pending[1].ID != "request-2" {
		t.Errorf("expected a nameless ask to survive, got %+v", pending[1])
	}
	if pending[1].ProfilePictureURL != "" {
		t.Errorf("expected no picture for a nameless ask, got %q", pending[1].ProfilePictureURL)
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
		members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}},
		requests: []circles.Request{
			{ID: "request-1", CircleID: "circle-1", AccountID: "asker-1", PublicKey: []byte("asker-1-key"), Status: circles.RequestPending},
		},
	}
	service := &Service{Store: store, Profiles: people(person("asker-1", "Sarah"))}

	err := service.Approve(context.Background(), "circle-1", "request-1", "admin-1", circles.SealedKeys{1: []byte("sealed")})
	if err != nil {
		t.Fatal(err)
	}
	if store.approved.name != "Sarah" {
		t.Errorf("stamped %q, want Sarah", store.approved.name)
	}
	if store.approved.expectedVersion != 1 {
		t.Errorf("expected the circle's current key version threaded through, got %d", store.approved.expectedVersion)
	}
	if store.approved.member.AccountID != "asker-1" || store.approved.member.Role != circles.RoleMember {
		t.Errorf("expected the asker admitted as a member, got %+v", store.approved.member)
	}
}

// sealed is built by the approving admin's device against the public
// key the ask carried. A requester who rotated their key after asking —
// a new device, a lost-keypair reset — has a different key now, so
// admitting them with keys sealed to the old one would hand them
// nothing they can open.
func TestApprove_RefusesWhenTheRequestersKeyHasChangedSinceTheAsk(t *testing.T) {
	store := &fakeStore{
		members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}},
		requests: []circles.Request{
			{ID: "request-1", CircleID: "circle-1", AccountID: "asker-1", PublicKey: []byte("old-key"), Status: circles.RequestPending},
		},
	}
	// person() gives asker-1 the key "asker-1-key" — different from what
	// the stored request snapshotted.
	service := &Service{Store: store, Profiles: people(person("asker-1", "Sarah"))}

	err := service.Approve(context.Background(), "circle-1", "request-1", "admin-1", circles.SealedKeys{1: []byte("sealed")})
	if !errors.Is(err, circles.ErrPublicKeyChanged) {
		t.Fatalf("expected ErrPublicKeyChanged, got %v", err)
	}
	if store.approved.requestID != "" {
		t.Error("nothing should have been admitted")
	}
}

// Only an admin may turn someone away — the same gate as Approve, since
// both are an admin deciding, not the requester.
func TestDeny_RefusesANonAdmin(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"member-1": {AccountID: "member-1", Role: circles.RoleMember}}}
	service := &Service{Store: store}

	if err := service.Deny(context.Background(), "circle-1", "request-1", "member-1"); !errors.Is(err, circles.ErrNotAdmin) {
		t.Fatalf("expected ErrNotAdmin, got %v", err)
	}
	if store.denied != "" {
		t.Error("nothing should have been denied")
	}
}

func TestDeny_AnAdminTurnsTheRequestAway(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}}}
	service := &Service{Store: store}

	if err := service.Deny(context.Background(), "circle-1", "request-1", "admin-1"); err != nil {
		t.Fatal(err)
	}
	if store.denied != "request-1" {
		t.Errorf("denied %q, want request-1", store.denied)
	}
}

// Asks are named by a hash of the account that made them, so the id in
// the path is checked against who is calling: an asker withdraws their
// own ask and nobody else's.
func TestCancel_WithdrawsTheCallersOwnAsk(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store}
	own := circles.RequestID("asker-1")

	if err := service.Cancel(context.Background(), "circle-1", own, "asker-1"); err != nil {
		t.Fatal(err)
	}
	if store.deleted.circleID != "circle-1" || store.deleted.requestID != own {
		t.Errorf("withdrew %+v, want %q in circle-1", store.deleted, own)
	}
}

// Somebody else's ask reads as not there rather than as forbidden, which
// would confirm that an ask under that id exists.
func TestCancel_SomeoneElsesAskIsNotYoursToWithdraw(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store}

	err := service.Cancel(context.Background(), "circle-1", circles.RequestID("asker-1"), "mallory")
	if !errors.Is(err, circles.ErrRequestNotFound) {
		t.Fatalf("expected ErrRequestNotFound, got %v", err)
	}
	if store.deleted.requestID != "" {
		t.Errorf("nothing should have been deleted, got %+v", store.deleted)
	}
}

// An admin answers an ask with Deny. Withdrawing is the asker's, so even
// an admin of that very circle cannot take someone's ask back.
func TestCancel_AnAdminCannotWithdrawAnAskThatIsNotTheirs(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}}}
	service := &Service{Store: store}

	err := service.Cancel(context.Background(), "circle-1", circles.RequestID("asker-1"), "admin-1")
	if !errors.Is(err, circles.ErrRequestNotFound) {
		t.Fatalf("expected ErrRequestNotFound, got %v", err)
	}
	if store.deleted.requestID != "" {
		t.Errorf("nothing should have been deleted, got %+v", store.deleted)
	}
}

// Whoever asked is not on the roster yet, so there is no membership to
// check: unlike Approve and Deny, nothing here reads one.
func TestCancel_NeedsNoMembership(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{}}
	service := &Service{Store: store}

	if err := service.Cancel(context.Background(), "circle-1", circles.RequestID("asker-1"), "asker-1"); err != nil {
		t.Fatalf("an asker who is no member must still be able to withdraw: %v", err)
	}
}

// An ask already answered, or already gone, is not one to withdraw; the
// caller is told so rather than being left to think it worked.
func TestCancel_SaysSoWhenTheAskIsNoLongerOpen(t *testing.T) {
	store := &fakeStore{deleteErr: circles.ErrRequestNotFound}
	service := &Service{Store: store}

	err := service.Cancel(context.Background(), "circle-1", circles.RequestID("asker-1"), "asker-1")
	if !errors.Is(err, circles.ErrRequestNotFound) {
		t.Fatalf("expected ErrRequestNotFound, got %v", err)
	}
}
