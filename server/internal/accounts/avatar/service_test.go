package avatar

import (
	"context"
	"testing"

	"mimoza-relay/internal/blobs"
)

type fakeBucket struct {
	key      string
	maxBytes int64
}

func (f *fakeBucket) UploadTarget(_ context.Context, key string, maxBytes int64) (blobs.UploadTarget, error) {
	f.key, f.maxBytes = key, maxBytes
	return blobs.UploadTarget{URL: "https://bucket.example/" + key}, nil
}

func (f *fakeBucket) DownloadURL(_ context.Context, key string) (string, error) {
	f.key = key
	return "https://cdn.example/" + key, nil
}

// A picture goes under the account that owns it, and is held to far less
// than a photo.
func TestUploadTarget_IsKeyedOnTheCallersOwnAccount(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{Bucket: bucket}

	if _, err := service.UploadTarget(context.Background(), "account-1", "hash-1"); err != nil {
		t.Fatal(err)
	}
	if bucket.key != "avatars/account-1/hash-1" {
		t.Errorf("key = %q, want avatars/account-1/hash-1", bucket.key)
	}
	if bucket.maxBytes != MaxSize {
		t.Errorf("maxBytes = %d, want the avatar cap", bucket.maxBytes)
	}
}

// Anyone signed in may read a picture they hold the key to. The id is a
// hash nobody can guess, and the only way to have one is a roster or a
// pending request the caller was already allowed to read.
func TestDownloadURL_IsKeyedOnWhoseItIs(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{Bucket: bucket}

	url, err := service.DownloadURL(context.Background(), "account-2", "hash-2")
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://cdn.example/avatars/account-2/hash-2" {
		t.Errorf("url = %q", url)
	}
}
