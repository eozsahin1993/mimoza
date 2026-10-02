package members

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type fakeBucket struct{ key string }

func (f *fakeBucket) DownloadURL(_ context.Context, key string) (string, error) {
	f.key = key
	return "https://cdn.example/" + key, nil
}

// withPicture gives one account a current picture, the way the accounts
// column would report it.
func withPicture(profiles *fakeProfiles, accountID, pictureID string) *fakeProfiles {
	profile := profiles.byID[accountID]
	profile.ProfilePictureID = pictureID
	profiles.byID[accountID] = profile
	return profiles
}

// Sharing a circle is what entitles you to a face: any member may ask
// for any other member's, and nobody outside may ask at all, in either
// position.
func TestProfilePictureURL_IsForMembersAboutMembers(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-1"))
	bucket := &fakeBucket{}
	service := serviceFor(store, withPicture(named(map[string]string{"member-1": "Ali"}), "member-1", "pic-1"))
	service.Blobs = bucket

	url, err := service.ProfilePictureURL(context.Background(), "circle-1", "member-1", "pic-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://cdn.example/account/member-1/picture/pic-1" {
		t.Errorf("url = %q, want the account-scoped key signed", url)
	}

	if _, err := service.ProfilePictureURL(context.Background(), "circle-1", "member-1", "pic-1", "outsider"); !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("an outsider asking: expected ErrNotMember, got %v", err)
	}
	if _, err := service.ProfilePictureURL(context.Background(), "circle-1", "stranger", "pic-1", "admin-1"); !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("asking about a non-member: expected ErrNotMember, got %v", err)
	}
}

// The id in the path has to be the one the profile names. A replaced
// picture can linger in the bucket while its deletion is best-effort,
// and a device holding a stale roster should hear "gone" rather than be
// handed a URL to it.
func TestProfilePictureURL_RefusesAnIdTheProfileDoesNotName(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-1"))
	service := serviceFor(store, withPicture(named(map[string]string{"member-1": "Ali"}), "member-1", "pic-2"))
	service.Blobs = &fakeBucket{}

	if _, err := service.ProfilePictureURL(context.Background(), "circle-1", "member-1", "pic-1", "admin-1"); !errors.Is(err, circles.ErrPictureNotFound) {
		t.Errorf("a stale id: expected ErrPictureNotFound, got %v", err)
	}

	none := serviceFor(store, named(map[string]string{"member-1": "Ali"}))
	none.Blobs = &fakeBucket{}
	if _, err := none.ProfilePictureURL(context.Background(), "circle-1", "member-1", "pic-1", "admin-1"); !errors.Is(err, circles.ErrPictureNotFound) {
		t.Errorf("no picture at all: expected ErrPictureNotFound, got %v", err)
	}
}

// The roster is how a device learns a member's picture changed: it
// carries the account's current id beside the name.
func TestRoster_CarriesEachMembersPictureID(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-1"))
	profiles := withPicture(named(map[string]string{"admin-1": "Sarah", "member-1": "Ali"}), "member-1", "pic-1")
	service := serviceFor(store, profiles)

	_, members, _, err := service.Roster(context.Background(), "circle-1", "admin-1")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]RosterMember{}
	for _, member := range members {
		byID[member.AccountID] = member
	}
	if byID["member-1"].ProfilePictureID != "pic-1" {
		t.Errorf("expected member-1's picture id on the roster, got %+v", byID["member-1"])
	}
	if byID["admin-1"].ProfilePictureID != "" {
		t.Errorf("expected no id for a member without a picture, got %q", byID["admin-1"].ProfilePictureID)
	}
	var _ accounts.Profile // the roster is the accounts column's view of a member
}
