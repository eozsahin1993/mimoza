package s3_test

import (
	"errors"
	"strings"
	"testing"

	"mimoza-relay/internal/circles"
	circless3 "mimoza-relay/internal/circles/s3"
	"mimoza-relay/internal/util/testsupport"
)

// A blob is written once. Membership proves someone is in the circle,
// never that they are the author of a post, so a second target for the
// same key would let any member replace a photo with one that still
// decrypts.
func TestUploadTarget_RefusesAKeyThatAlreadyHasBytes(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	key := circless3.PostKey(testsupport.UniqueCircleID(t), "post-1")

	target, err := store.UploadTarget(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	testsupport.PostBlob(t, target.URL, target.Fields, []byte("ciphertext"))

	if _, err := store.UploadTarget(t.Context(), key); !errors.Is(err, circles.ErrBlobExists) {
		t.Fatalf("expected ErrBlobExists, got %v", err)
	}
}

// A cover is a fresh id on every change, so its key is as immutable as a
// post's and takes the same path.
func TestUploadTarget_CoversAreTheirOwnKeys(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	circleID := testsupport.UniqueCircleID(t)

	first, err := store.UploadTarget(t.Context(), circless3.CoverKey(circleID, "cover-1"))
	if err != nil {
		t.Fatal(err)
	}
	testsupport.PostBlob(t, first.URL, first.Fields, []byte("first cover"))

	// A new cover is a new id, so it does not collide with the old one.
	if _, err := store.UploadTarget(t.Context(), circless3.CoverKey(circleID, "cover-2")); err != nil {
		t.Fatalf("a new cover id must be free to upload: %v", err)
	}
	// The same id twice is the ordinary refusal.
	if _, err := store.UploadTarget(t.Context(), circless3.CoverKey(circleID, "cover-1")); !errors.Is(err, circles.ErrBlobExists) {
		t.Fatalf("expected ErrBlobExists, got %v", err)
	}
}

// The policy the relay signs is what S3 enforces, so an upload that
// ignores it is rejected at the bucket rather than discovered later.
func TestUploadTarget_SignsTheSizeAndTypeIntoThePolicy(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	target, err := store.UploadTarget(t.Context(), circless3.PostKey(testsupport.UniqueCircleID(t), "post-1"))
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

// Deleting is idempotent: a retried deletion is the same outcome, and a
// key that never existed is already deleted.
func TestDelete_IsIdempotent(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	key := circless3.PostKey(testsupport.UniqueCircleID(t), "post-1")

	target, err := store.UploadTarget(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	testsupport.PostBlob(t, target.URL, target.Fields, []byte("ciphertext"))

	for range 2 {
		if err := store.Delete(t.Context(), key); err != nil {
			t.Fatalf("Delete: %v", err)
		}
	}
	// The key is free again, which is what proves the bytes are gone.
	if _, err := store.UploadTarget(t.Context(), key); err != nil {
		t.Fatalf("expected the key to be free after deletion, got %v", err)
	}
	if err := store.Delete(t.Context(), circless3.PostKey("never", "existed")); err != nil {
		t.Errorf("deleting nothing must not be an error: %v", err)
	}
}

// Deleting a circle takes every photo and every cover it ever had, and
// touches no other circle's prefix — including one whose id merely
// starts with the same characters.
func TestDeleteCircle_SweepsOnlyItsOwnPrefix(t *testing.T) {
	store := testsupport.NewBlobBucket(t)
	circleID := testsupport.UniqueCircleID(t)
	neighbour := circleID + "-second"

	for _, key := range []string{
		circless3.PostKey(circleID, "post-1"),
		circless3.PostKey(circleID, "post-2"),
		circless3.CoverKey(circleID, "cover-1"),
		circless3.PostKey(neighbour, "post-1"),
	} {
		target, err := store.UploadTarget(t.Context(), key)
		if err != nil {
			t.Fatal(err)
		}
		testsupport.PostBlob(t, target.URL, target.Fields, []byte("ciphertext"))
	}

	if err := store.DeleteCircle(t.Context(), circleID); err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{
		circless3.PostKey(circleID, "post-1"),
		circless3.PostKey(circleID, "post-2"),
		circless3.CoverKey(circleID, "cover-1"),
	} {
		if _, err := store.UploadTarget(t.Context(), key); err != nil {
			t.Errorf("expected %s to be gone, got %v", key, err)
		}
	}
	if _, err := store.UploadTarget(t.Context(), circless3.PostKey(neighbour, "post-1")); !errors.Is(err, circles.ErrBlobExists) {
		t.Error("a circle whose id starts the same must keep its photos")
	}
}

// With its settings and key in SSM the relay hands out a CloudFront URL
// rather than an S3 one: the handover Terraform writes and the relay
// reads. CloudFront is not emulated, so this proves the relay's half,
// not that CloudFront accepts the signature.
func TestDownloadURL_SignsForTheCDNWhenSSMSaysSo(t *testing.T) {
	store := testsupport.NewBlobBucketWithCDN(t, testsupport.UniqueCircleID(t))
	circleID := testsupport.UniqueCircleID(t)

	url, err := store.DownloadURL(t.Context(), circless3.PostKey(circleID, "post-1"))
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

	url, err := store.DownloadURL(t.Context(), circless3.PostKey(testsupport.UniqueCircleID(t), "post-1"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(url, "cdn.example.com") {
		t.Fatalf("expected a presigned S3 url, got %s", url)
	}
}
