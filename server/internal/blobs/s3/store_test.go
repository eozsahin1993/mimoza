package s3_test

import (
	"errors"
	"strings"
	"testing"

	"mimoza-relay/internal/blobs"
	"mimoza-relay/internal/util/testsupport"
)

// postKey and coverKey mirror what the circles column computes. They are
// spelled out here so the bucket's own tests do not lean on a column
// that only happens to be its first caller.
func postKey(circleID, postID string) string { return circleID + "/" + postID }

func coverKey(circleID, coverID string) string { return circleID + "/cover/" + coverID }

// A key is written once. Being allowed to upload proves someone is in
// the circle, never that they wrote a given post, so a second target for
// the same key would let any member replace what is there with something
// that still decrypts.
func TestUploadTarget_RefusesAKeyThatAlreadyHasBytes(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	key := postKey(testsupport.UniqueCircleID(t), "post-1")

	target, err := store.UploadTarget(t.Context(), key, 0)
	if err != nil {
		t.Fatal(err)
	}
	testsupport.PostBlob(t, target.URL, target.Fields, []byte("ciphertext"))

	if _, err := store.UploadTarget(t.Context(), key, 0); !errors.Is(err, blobs.ErrExists) {
		t.Fatalf("expected ErrExists, got %v", err)
	}

	// Asking twice before any bytes land is an ordinary retry: nothing
	// exists yet to be replaced.
	free := postKey(testsupport.UniqueCircleID(t), "post-2")
	if _, err := store.UploadTarget(t.Context(), free, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UploadTarget(t.Context(), free, 0); err != nil {
		t.Fatalf("a retried target before any upload must work: %v", err)
	}
}

// A cover and an avatar both mint a fresh id from the content, so their
// keys are as immutable as a post's and take the same path.
func TestUploadTarget_AFreshIdIsAFreeKey(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	circleID := testsupport.UniqueCircleID(t)

	first, err := store.UploadTarget(t.Context(), coverKey(circleID, "cover-1"), 0)
	if err != nil {
		t.Fatal(err)
	}
	testsupport.PostBlob(t, first.URL, first.Fields, []byte("first cover"))

	if _, err := store.UploadTarget(t.Context(), coverKey(circleID, "cover-2"), 0); err != nil {
		t.Fatalf("a new id must be free to upload: %v", err)
	}
	if _, err := store.UploadTarget(t.Context(), coverKey(circleID, "cover-1"), 0); !errors.Is(err, blobs.ErrExists) {
		t.Fatalf("expected ErrExists, got %v", err)
	}
}

// The policy the relay signs is what S3 enforces, so an upload that
// ignores it is refused at the bucket rather than discovered later.
func TestUploadTarget_SignsTheSizeAndTypeIntoThePolicy(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	target, err := store.UploadTarget(t.Context(), postKey(testsupport.UniqueCircleID(t), "post-1"), 0)
	if err != nil {
		t.Fatal(err)
	}

	if target.Fields["Content-Type"] != "application/octet-stream" {
		t.Errorf("expected a pinned content type, got %q", target.Fields["Content-Type"])
	}
	for _, field := range []string{"policy", "key"} {
		if target.Fields[field] == "" {
			t.Errorf("expected the form to carry %q", field)
		}
	}
	if target.URL == "" {
		t.Error("expected somewhere to send the bytes")
	}
}

// The cap is in the signed policy, so S3 refuses an oversized upload
// itself. A caller may ask for less than the bucket's limit, which is
// how an avatar is held to far less than a photo.
func TestUploadTarget_TheCallersLimitIsEnforcedByS3(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	key := postKey(testsupport.UniqueCircleID(t), "post-1")

	target, err := store.UploadTarget(t.Context(), key, 16)
	if err != nil {
		t.Fatal(err)
	}
	if status := testsupport.TryPostBlob(t, target.URL, target.Fields, []byte(strings.Repeat("x", 64))); status < 400 {
		t.Fatalf("expected S3 to refuse an oversized upload, got %d", status)
	}
	// Nothing landed, so the key is still free.
	if _, err := store.UploadTarget(t.Context(), key, 16); err != nil {
		t.Fatalf("a refused upload must leave the key free: %v", err)
	}

	within, err := store.UploadTarget(t.Context(), key, 1024)
	if err != nil {
		t.Fatal(err)
	}
	testsupport.PostBlob(t, within.URL, within.Fields, []byte("small enough"))
}

// Deleting is idempotent: a retried deletion is the same outcome, and a
// key that never existed is already deleted.
func TestDelete_IsIdempotent(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	key := postKey(testsupport.UniqueCircleID(t), "post-1")

	target, err := store.UploadTarget(t.Context(), key, 0)
	if err != nil {
		t.Fatal(err)
	}
	testsupport.PostBlob(t, target.URL, target.Fields, []byte("ciphertext"))

	for range 2 {
		if err := store.Delete(t.Context(), key); err != nil {
			t.Fatalf("Delete: %v", err)
		}
	}
	if _, err := store.UploadTarget(t.Context(), key, 0); err != nil {
		t.Fatalf("expected the key to be free after deletion, got %v", err)
	}
	if err := store.Delete(t.Context(), postKey("never", "existed")); err != nil {
		t.Errorf("deleting nothing must not be an error: %v", err)
	}
}

// A sweep takes everything under the prefix it was given and nothing
// else — including a neighbour whose id starts with the same characters,
// which is what the caller's trailing slash is for.
func TestDeletePrefix_SweepsOnlyWhatItWasGiven(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	circleID := testsupport.UniqueCircleID(t)
	neighbour := circleID + "-second"

	for _, key := range []string{
		postKey(circleID, "post-1"),
		postKey(circleID, "post-2"),
		coverKey(circleID, "cover-1"),
		postKey(neighbour, "post-1"),
	} {
		target, err := store.UploadTarget(t.Context(), key, 0)
		if err != nil {
			t.Fatal(err)
		}
		testsupport.PostBlob(t, target.URL, target.Fields, []byte("ciphertext"))
	}

	if err := store.DeletePrefix(t.Context(), circleID+"/"); err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{
		postKey(circleID, "post-1"),
		postKey(circleID, "post-2"),
		coverKey(circleID, "cover-1"),
	} {
		if _, err := store.UploadTarget(t.Context(), key, 0); err != nil {
			t.Errorf("expected %s to be gone, got %v", key, err)
		}
	}
	if _, err := store.UploadTarget(t.Context(), postKey(neighbour, "post-1"), 0); !errors.Is(err, blobs.ErrExists) {
		t.Error("a neighbour whose id starts the same must keep its bytes")
	}
	// Sweeping again, and sweeping a prefix that never held anything,
	// are both ordinary.
	if err := store.DeletePrefix(t.Context(), circleID+"/"); err != nil {
		t.Errorf("a repeated sweep must be a no-op: %v", err)
	}
}

// With its settings and key in SSM the relay hands out a CloudFront URL
// rather than an S3 one: the handover Terraform writes and the relay
// reads. CloudFront is not emulated, so this proves the relay's half,
// not that CloudFront accepts the signature.
func TestDownloadURL_SignsForTheCDNWhenSSMSaysSo(t *testing.T) {
	store := testsupport.NewBlobBucketWithCDN(t, testsupport.UniqueCircleID(t))
	circleID := testsupport.UniqueCircleID(t)

	url, err := store.DownloadURL(t.Context(), postKey(circleID, "post-1"))
	if err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(url, "https://cdn.example.com/"+circleID+"/post-1?") {
		t.Fatalf("expected a signed cdn url, got %s", url)
	}
	for _, param := range []string{"Expires=", "Signature=", "Key-Pair-Id=K123"} {
		if !strings.Contains(url, param) {
			t.Fatalf("signed url is missing %s: %s", param, url)
		}
	}
}

// Without those parameters nothing changes: downloads stay on presigned
// S3 URLs, which is how a local run and any pre-CDN environment work.
func TestDownloadURL_StaysOnS3WithoutSettings(t *testing.T) {
	store := testsupport.NewBlobBucket(t)

	url, err := store.DownloadURL(t.Context(), postKey(testsupport.UniqueCircleID(t), "post-1"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(url, "cdn.example.com") {
		t.Fatalf("expected a presigned S3 url, got %s", url)
	}
}
