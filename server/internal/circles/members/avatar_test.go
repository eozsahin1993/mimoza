package members

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/blobs"
	"mimoza-relay/internal/circles"
)

type fakeBucket struct {
	key      string
	maxBytes int64
	deleted  []string
}

func (f *fakeBucket) UploadTarget(_ context.Context, key string, maxBytes int64) (blobs.UploadTarget, error) {
	f.key, f.maxBytes = key, maxBytes
	return blobs.UploadTarget{URL: "https://bucket.example/" + key}, nil
}

func (f *fakeBucket) DownloadURL(_ context.Context, key string) (string, error) {
	f.key = key
	return "https://cdn.example/" + key, nil
}

func (f *fakeBucket) Delete(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return nil
}

func withBucket(store *fakeStore, bucket *fakeBucket) *Service {
	service := serviceFor(store, named(map[string]string{"member-1": "Ali", "admin-1": "Sarah"}))
	service.Blobs = bucket
	return service
}

// A picture is circle content: it goes under the circle's own prefix,
// sealed to the circle, and only its owner may put it there.
func TestSetAvatar_IsOnlyYourOwn(t *testing.T) {
	store := roster(adminMember("admin-1"), plainMember("member-1"))
	bucket := &fakeBucket{}
	service := withBucket(store, bucket)

	err := service.SetAvatar(context.Background(), "circle-1", "member-1", "admin-1", "hash-1", 1)
	if !errors.Is(err, circles.ErrNotTheAuthor) {
		t.Fatalf("expected ErrNotTheAuthor, got %v", err)
	}

	if err := service.SetAvatar(context.Background(), "circle-1", "member-1", "member-1", "hash-1", 1); err != nil {
		t.Fatal(err)
	}
	if store.avatarID != "hash-1" || store.avatarVersion != 1 {
		t.Errorf("stored %q at version %d", store.avatarID, store.avatarVersion)
	}
}

// The bytes are sealed under a content key, so the version recorded has
// to be the one they were sealed under — the circle's current.
func TestSetAvatar_RefusesAStaleKeyVersion(t *testing.T) {
	store := roster(plainMember("member-1"))
	service := withBucket(store, &fakeBucket{})

	err := service.SetAvatar(context.Background(), "circle-1", "member-1", "member-1", "hash-1", 99)
	if !errors.Is(err, circles.ErrStaleKeyVersion) {
		t.Fatalf("expected ErrStaleKeyVersion, got %v", err)
	}
	if store.avatarID != "" {
		t.Error("nothing should have been written")
	}
}

// Replacing a picture retires the one it replaced: nothing names it any
// more, and it is sealed to a circle that has moved on.
func TestSetAvatar_RetiresThePictureItReplaced(t *testing.T) {
	previous := plainMember("member-1")
	previous.AvatarID = "old"
	store := roster(previous)
	bucket := &fakeBucket{}
	service := withBucket(store, bucket)

	if err := service.SetAvatar(context.Background(), "circle-1", "member-1", "member-1", "new", 1); err != nil {
		t.Fatal(err)
	}
	if len(bucket.deleted) != 1 || bucket.deleted[0] != "circle-1/avatar/member-1/old" {
		t.Fatalf("deleted %v, want the old picture", bucket.deleted)
	}
}

// Uploading is a member's own; reading is any member's, since what comes
// back is ciphertext only the circle can open.
func TestAvatarBlobs_AreKeyedUnderTheCircle(t *testing.T) {
	store := roster(plainMember("member-1"))
	bucket := &fakeBucket{}
	service := withBucket(store, bucket)

	if _, err := service.AvatarUploadTarget(context.Background(), "circle-1", "outsider", "hash-1"); !errors.Is(err, circles.ErrNotMember) {
		t.Fatalf("expected ErrNotMember, got %v", err)
	}
	if _, err := service.AvatarUploadTarget(context.Background(), "circle-1", "member-1", "hash-1"); err != nil {
		t.Fatal(err)
	}
	if bucket.key != "circle-1/avatar/member-1/hash-1" {
		t.Errorf("key = %q", bucket.key)
	}
	if bucket.maxBytes != maxAvatarSize {
		t.Errorf("maxBytes = %d, want the avatar cap", bucket.maxBytes)
	}

	url, err := service.AvatarURL(context.Background(), "circle-1", "member-1", "hash-1", "member-1")
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://cdn.example/circle-1/avatar/member-1/hash-1" {
		t.Errorf("url = %q", url)
	}
	if _, err := service.AvatarURL(context.Background(), "circle-1", "member-1", "hash-1", "outsider"); !errors.Is(err, circles.ErrNotMember) {
		t.Error("an outsider must not be handed a URL")
	}
}

// A picture sealed to a circle is no use once its owner is gone, and
// nothing will ever name it again.
func TestDepartures_TakeThePictureWithThem(t *testing.T) {
	leaving := adminMember("member-1")
	leaving.AvatarID = "hash-1"

	t.Run("leaving", func(t *testing.T) {
		store := roster(adminMember("admin-1"), leaving)
		bucket := &fakeBucket{}
		service := withBucket(store, bucket)

		if err := service.Leave(context.Background(), "circle-1", "member-1"); err != nil {
			t.Fatal(err)
		}
		if len(bucket.deleted) != 1 || bucket.deleted[0] != "circle-1/avatar/member-1/hash-1" {
			t.Fatalf("deleted %v", bucket.deleted)
		}
	})

	t.Run("being removed", func(t *testing.T) {
		removed := plainMember("member-1")
		removed.AvatarID = "hash-1"
		store := roster(adminMember("admin-1"), removed)
		bucket := &fakeBucket{}
		service := withBucket(store, bucket)

		if err := service.Remove(context.Background(), "circle-1", "member-1", "admin-1", 1, nil); err != nil {
			t.Fatal(err)
		}
		if len(bucket.deleted) != 1 || bucket.deleted[0] != "circle-1/avatar/member-1/hash-1" {
			t.Fatalf("deleted %v", bucket.deleted)
		}
	})
}
