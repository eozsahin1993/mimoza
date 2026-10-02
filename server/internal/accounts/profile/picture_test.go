package profile

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

// The key carries the account, so nobody can write into anyone else's
// prefix, and the cap is a picture's, not a photo's.
func TestPictureUploadTarget_IsKeyedUnderTheAccount(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{Store: &fakeStore{}, Blobs: bucket}

	if _, err := service.PictureUploadTarget(context.Background(), "account-1", "pic-1"); err != nil {
		t.Fatal(err)
	}
	if bucket.key != "account/account-1/picture/pic-1" {
		t.Errorf("key = %q", bucket.key)
	}
	if bucket.maxBytes != maxPictureSize {
		t.Errorf("maxBytes = %d, want the picture cap", bucket.maxBytes)
	}
}

// Replacing a picture retires the one it replaced: nothing names it any
// more. Setting the very first one retires nothing.
func TestSetPicture_RetiresThePreviousOne(t *testing.T) {
	store := &fakeStore{profile: accounts.Profile{AccountID: "account-1", ProfilePictureID: "old"}}
	bucket := &fakeBucket{}
	service := &Service{Store: store, Blobs: bucket}

	got, err := service.SetPicture(context.Background(), "account-1", "new")
	if err != nil {
		t.Fatal(err)
	}
	if got.ProfilePictureID != "new" {
		t.Errorf("expected the stored profile back with the new id, got %+v", got)
	}
	if len(bucket.deleted) != 1 || bucket.deleted[0] != "account/account-1/picture/old" {
		t.Errorf("deleted %v, want the old picture", bucket.deleted)
	}

	fresh := &fakeBucket{}
	first := &Service{Store: &fakeStore{}, Blobs: fresh}
	if _, err := first.SetPicture(context.Background(), "account-1", "pic-1"); err != nil {
		t.Fatal(err)
	}
	if len(fresh.deleted) != 0 {
		t.Errorf("a first picture has nothing to retire, deleted %v", fresh.deleted)
	}
}

// A roster is refetched when its version moves, and that version lives
// on the circle: a new picture has to move every circle the account is
// in, and wake the members, or nobody sees it until something else does.
func TestSetPicture_TouchesEveryMembershipAndWakesThem(t *testing.T) {
	memberships := &fakeCircles{waiting: []string{"circle-1", "circle-2"}}
	notifier := &fakeNotifier{}
	service := &Service{Store: &fakeStore{}, Circles: memberships, Notify: notifier, Blobs: &fakeBucket{}}

	if _, err := service.SetPicture(context.Background(), "account-1", "pic-1"); err != nil {
		t.Fatal(err)
	}
	if memberships.touched != 1 {
		t.Errorf("expected one pass over the memberships, got %d", memberships.touched)
	}
	if memberships.calls != 0 {
		t.Error("a new picture must not flag anyone for a rewrap")
	}
	if len(notifier.events) != 2 {
		t.Fatalf("expected a roster nudge per circle, got %+v", notifier.events)
	}
	for _, event := range notifier.events {
		if event.Kind != circles.NotifyRoster || event.ActorID != "account-1" {
			t.Errorf("unexpected notification: %+v", event)
		}
	}
}

// Clearing is the same write with an empty id: the row forgets the
// picture and the bytes go.
func TestClearPicture_RemovesAndRetires(t *testing.T) {
	store := &fakeStore{profile: accounts.Profile{AccountID: "account-1", ProfilePictureID: "old"}}
	bucket := &fakeBucket{}
	service := &Service{Store: store, Blobs: bucket}

	got, err := service.SetPicture(context.Background(), "account-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.ProfilePictureID != "" {
		t.Errorf("expected no picture, got %+v", got)
	}
	if len(store.pictures) != 1 || store.pictures[0] != "" {
		t.Errorf("expected one clearing write, got %v", store.pictures)
	}
	if len(bucket.deleted) != 1 || bucket.deleted[0] != "account/account-1/picture/old" {
		t.Errorf("deleted %v, want the old picture", bucket.deleted)
	}
}

// A write that failed must leave the old picture alone and tell nobody:
// the row still names it, so deleting it would break a working picture.
func TestAFailedPictureWriteRetiresNothing(t *testing.T) {
	store := &fakeStore{
		profile:    accounts.Profile{AccountID: "account-1", ProfilePictureID: "old"},
		pictureErr: accounts.ErrNotFound,
	}
	bucket := &fakeBucket{}
	memberships := &fakeCircles{waiting: []string{"circle-1"}}
	service := &Service{Store: store, Blobs: bucket, Circles: memberships}

	if _, err := service.SetPicture(context.Background(), "account-1", "new"); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if len(bucket.deleted) != 0 {
		t.Errorf("deleted %v after a failed write", bucket.deleted)
	}
	if memberships.touched != 0 {
		t.Error("nothing should have been announced")
	}
}

// The touch failing is not the picture failing, but the caller is told:
// a device that believes everyone was woken when nobody was would wait
// forever for them to notice.
func TestAFailedTouchIsReported(t *testing.T) {
	service := &Service{
		Store:   &fakeStore{},
		Blobs:   &fakeBucket{},
		Circles: &fakeCircles{err: errors.New("dynamo is down")},
	}
	if _, err := service.SetPicture(context.Background(), "account-1", "pic-1"); err == nil {
		t.Fatal("expected the failure to reach the caller")
	}
}

// The relay runs with the circles column wired; without it a picture is
// still recorded rather than panicking.
func TestSetPictureWithoutTheCirclesColumnStillRecords(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store, Blobs: &fakeBucket{}}

	got, err := service.SetPicture(context.Background(), "account-1", "pic-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.ProfilePictureID != "pic-1" {
		t.Errorf("expected the picture recorded, got %+v", got)
	}
}
