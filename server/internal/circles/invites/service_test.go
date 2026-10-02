package invites

import (
	"context"
	"testing"
	"time"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type fakeStore struct {
	invite  circles.Invite
	members map[string]circles.Member
	created circles.Invite
	invites []circles.Invite
	revoked string
}

func (f *fakeStore) GetCircle(_ context.Context, circleID string) (circles.Circle, error) {
	return circles.Circle{ID: circleID, Name: "Family"}, nil
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

func (f *fakeStore) CreateInvite(_ context.Context, invite circles.Invite) error {
	f.created = invite
	return nil
}

func (f *fakeStore) GetInvite(_ context.Context, code string) (circles.Invite, error) {
	if code != f.invite.Code {
		return circles.Invite{}, circles.ErrInviteNotFound
	}
	return f.invite, nil
}

func (f *fakeStore) ListInvites(context.Context, string) ([]circles.Invite, error) {
	return f.invites, nil
}

func (f *fakeStore) RevokeInvite(_ context.Context, _, code string) error {
	f.revoked = code
	return nil
}

type fakeProfiles struct{ byID map[string]accounts.Profile }

func (f *fakeProfiles) GetProfile(_ context.Context, accountID string) (accounts.Profile, error) {
	profile, ok := f.byID[accountID]
	if !ok {
		return accounts.Profile{}, accounts.ErrNotFound
	}
	return profile, nil
}

type fakeBucket struct{ key string }

func (f *fakeBucket) DownloadURL(_ context.Context, key string) (string, error) {
	f.key = key
	return "https://cdn.example/" + key, nil
}

func liveInvite() circles.Invite {
	return circles.Invite{Code: "code", CircleID: "circle-1", CreatedBy: "admin-1", ExpiresAt: time.Now().Add(time.Hour)}
}

// Only a current admin may make or revoke a code — the whole point of an
// invite is that letting people in is an admin decision.
func TestCreate_RefusesANonAdmin(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"member-1": {AccountID: "member-1", Role: circles.RoleMember}}}
	service := &Service{Store: store, Retention: time.Hour}

	if _, err := service.Create(context.Background(), "circle-1", "member-1"); err == nil {
		t.Fatal("expected a non-admin to be refused")
	}
	if store.created.Code != "" {
		t.Error("nothing should have been created")
	}
}

func TestRevoke_RefusesANonAdmin(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"member-1": {AccountID: "member-1", Role: circles.RoleMember}}}
	service := &Service{Store: store}

	if err := service.Revoke(context.Background(), "circle-1", "code", "member-1"); err == nil {
		t.Fatal("expected a non-admin to be refused")
	}
	if store.revoked != "" {
		t.Error("nothing should have been revoked")
	}
}

// A live code, owned by the circle it was made for, lasting as long as
// Retention says — not forever, which would be a standing way in long
// after whoever shared it forgot they had.
func TestCreate_MintsALiveCodeForThisCircle(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}}}
	service := &Service{Store: store, Retention: time.Hour}

	invite, err := service.Create(context.Background(), "circle-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	if invite.Code == "" {
		t.Error("expected a non-empty code")
	}
	if invite.CircleID != "circle-1" || invite.CreatedBy != "admin-1" {
		t.Errorf("expected it owned by the circle and the admin, got %+v", invite)
	}
	if !invite.ExpiresAt.After(time.Now()) || invite.ExpiresAt.After(time.Now().Add(2*time.Hour)) {
		t.Errorf("expected ExpiresAt roughly Retention out, got %v", invite.ExpiresAt)
	}
	if store.created.Code != invite.Code {
		t.Error("expected the same invite to reach the store")
	}
}

// A code with no configured Retention still gets a lifetime — the
// default, not an invite that expires the instant it is made.
func TestCreate_FallsBackToTheDefaultRetention(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}}}
	service := &Service{Store: store}

	invite, err := service.Create(context.Background(), "circle-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	if !invite.ExpiresAt.After(time.Now().Add(24 * time.Hour)) {
		t.Errorf("expected the multi-day default retention, got ExpiresAt %v", invite.ExpiresAt)
	}
}

// Live codes are every admin's to see, not just whoever made them — an
// admin who did not hand one out still has to be able to revoke it.
func TestList_RefusesANonAdmin(t *testing.T) {
	store := &fakeStore{members: map[string]circles.Member{"member-1": {AccountID: "member-1", Role: circles.RoleMember}}}
	service := &Service{Store: store}

	if _, err := service.List(context.Background(), "circle-1", "member-1"); err == nil {
		t.Fatal("expected a non-admin to be refused")
	}
}

func TestList_ReturnsTheCirclesLiveInvites(t *testing.T) {
	store := &fakeStore{
		members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}},
		invites: []circles.Invite{{Code: "code-1", CircleID: "circle-1"}, {Code: "code-2", CircleID: "circle-1"}},
	}
	service := &Service{Store: store}

	invites, err := service.List(context.Background(), "circle-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(invites) != 2 {
		t.Fatalf("expected both invites, got %d", len(invites))
	}
}

func TestRevoke_AnAdminTakesTheCodeAway(t *testing.T) {
	store := &fakeStore{
		invite:  liveInvite(),
		members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}},
	}
	service := &Service{Store: store}

	if err := service.Revoke(context.Background(), "circle-1", "code", "admin-1"); err != nil {
		t.Fatal(err)
	}
	if store.revoked != "code" {
		t.Errorf("revoked %q, want code", store.revoked)
	}
}

// Someone deciding whether to ask sees who invited them: a name and,
// when there is one, a picture — already signed, since whoever opens a
// preview is going to look at it right there.
func TestPreview_CarriesTheInvitersNameAndSignedPicture(t *testing.T) {
	store := &fakeStore{invite: liveInvite(), members: map[string]circles.Member{"admin-1": {AccountID: "admin-1", Role: circles.RoleAdmin}}}
	bucket := &fakeBucket{}
	service := &Service{
		Store:    store,
		Profiles: &fakeProfiles{byID: map[string]accounts.Profile{"admin-1": {AccountID: "admin-1", Name: "Sarah", ProfilePictureID: "pic-1"}}},
		Blobs:    bucket,
	}

	preview, err := service.Preview(context.Background(), "code")
	if err != nil {
		t.Fatal(err)
	}
	if preview.InvitedBy != "Sarah" {
		t.Errorf("expected the inviter named, got %+v", preview)
	}
	if preview.ProfilePictureURL != "https://cdn.example/account/admin-1/picture/pic-1" {
		t.Errorf("url = %q", preview.ProfilePictureURL)
	}
}

// An inviter with no picture, or a profile that cannot be read, leaves
// the field empty rather than failing the whole preview — someone
// deciding whether to ask is owed the circle's name either way.
func TestPreview_LeavesThePictureEmptyWhenThereIsNone(t *testing.T) {
	store := &fakeStore{invite: liveInvite()}
	withName := &Service{
		Store:    store,
		Profiles: &fakeProfiles{byID: map[string]accounts.Profile{"admin-1": {AccountID: "admin-1", Name: "Sarah"}}},
		Blobs:    &fakeBucket{},
	}
	preview, err := withName.Preview(context.Background(), "code")
	if err != nil {
		t.Fatal(err)
	}
	if preview.ProfilePictureURL != "" {
		t.Errorf("expected no url, got %q", preview.ProfilePictureURL)
	}

	noProfile := &Service{Store: store, Profiles: &fakeProfiles{byID: map[string]accounts.Profile{}}, Blobs: &fakeBucket{}}
	preview, err = noProfile.Preview(context.Background(), "code")
	if err != nil {
		t.Fatal(err)
	}
	if preview.InvitedBy != "" || preview.ProfilePictureURL != "" {
		t.Errorf("expected a nameless, pictureless preview, got %+v", preview)
	}
}

func TestPreview_RefusesAnUnknownCode(t *testing.T) {
	service := &Service{Store: &fakeStore{invite: liveInvite()}}
	if _, err := service.Preview(context.Background(), "unknown"); err == nil {
		t.Fatal("expected an unknown code to be refused")
	}
}
