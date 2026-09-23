package posts

import (
	"context"
	"errors"
	"testing"
	"time"

	"mimoza-relay/internal/blobs"
	"mimoza-relay/internal/circles"
)

// A photo goes up before the post that names it, so a crash in between
// leaves an orphan rather than a post pointing at nothing. Being allowed
// to upload is membership, nothing more.
func TestUploadTarget_IsForMembersOnly(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{
		Store: &fakeStore{members: map[string]circles.Member{"member-1": {AccountID: "member-1"}}},
		Blobs: bucket,
	}

	if _, err := service.UploadTarget(context.Background(), "circle-1", "post-1", "outsider"); !errors.Is(err, circles.ErrNotMember) {
		t.Fatalf("expected ErrNotMember, got %v", err)
	}
	if bucket.key != "" {
		t.Error("an outsider must not reach the bucket at all")
	}

	if _, err := service.UploadTarget(context.Background(), "circle-1", "post-1", "member-1"); err != nil {
		t.Fatal(err)
	}
	if bucket.key != "circle-1/post-1" {
		t.Errorf("key = %q, want circle-1/post-1", bucket.key)
	}
	if bucket.maxBytes != maxPhotoSize {
		t.Errorf("maxBytes = %d, want the photo cap", bucket.maxBytes)
	}
}

// Invalidating the edge is best-effort, so refusing to sign is what
// actually stops a deleted photo being fetched again.
func TestPhotoURL_RefusesADeletedPost(t *testing.T) {
	member := map[string]circles.Member{"member-1": {AccountID: "member-1"}}

	live := &Service{
		Store: &fakeStore{members: member, post: circles.Entry{ID: "live", HasBlob: true}},
		Blobs: &fakeBucket{},
	}
	if _, err := live.PhotoURL(context.Background(), "circle-1", "live", "member-1"); err != nil {
		t.Fatal(err)
	}
	if key := live.Blobs.(*fakeBucket).key; key != "circle-1/live" {
		t.Errorf("key = %q, want circle-1/live", key)
	}
	if _, err := live.PhotoURL(context.Background(), "circle-1", "live", "outsider"); !errors.Is(err, circles.ErrNotMember) {
		t.Error("an outsider must not be handed a URL")
	}

	// A deleted post and one that never had a photo are the same answer:
	// there is nothing to fetch.
	for name, post := range map[string]circles.Entry{
		"deleted": {ID: "deleted", HasBlob: true, DeletedAt: time.Now()},
		"textual": {ID: "textual"},
	} {
		service := &Service{Store: &fakeStore{members: member, post: post}, Blobs: &fakeBucket{}}
		if _, err := service.PhotoURL(context.Background(), "circle-1", post.ID, "member-1"); !errors.Is(err, circles.ErrEntryNotFound) {
			t.Errorf("%s: expected ErrEntryNotFound, got %v", name, err)
		}
	}
}

// fakeBucket records the key and the cap it was asked for, which is all
// this slice decides once the caller is allowed through.
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
