package circle

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/blobs"
	"mimoza-relay/internal/circles"
)

// fakeBucket records the key and the cap it was asked for, which is all
// this slice decides once the caller is allowed through.
type fakeBucket struct {
	key      string
	maxBytes int64
	swept    []string
}

func (f *fakeBucket) UploadTarget(_ context.Context, key string, maxBytes int64) (blobs.UploadTarget, error) {
	f.key, f.maxBytes = key, maxBytes
	return blobs.UploadTarget{URL: "https://bucket.example/" + key}, nil
}

func (f *fakeBucket) DownloadURL(_ context.Context, key string) (string, error) {
	f.key = key
	return "https://cdn.example/" + key, nil
}

func (f *fakeBucket) DeletePrefix(_ context.Context, prefix string) error {
	f.swept = append(f.swept, prefix)
	return nil
}

func roleIs(role string) func(context.Context, string, string) (circles.Member, error) {
	return func(_ context.Context, _, accountID string) (circles.Member, error) {
		return circles.Member{AccountID: accountID, Role: role}, nil
	}
}

// Only an admin can point a circle at a new cover, so only an admin may
// put one in the bucket. A member could otherwise leave objects at keys
// nothing will ever name.
func TestCoverUploadTarget_IsForAdminsOnly(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{Store: &fakeStore{getMember: roleIs(circles.RoleMember)}, Blobs: bucket}

	if _, err := service.CoverUploadTarget(context.Background(), "circle-1", "cover-1", "member-1"); !errors.Is(err, circles.ErrNotAdmin) {
		t.Fatalf("expected ErrNotAdmin, got %v", err)
	}
	if bucket.key != "" {
		t.Error("a member must not reach the bucket at all")
	}

	service = &Service{Store: &fakeStore{getMember: roleIs(circles.RoleAdmin)}, Blobs: bucket}
	if _, err := service.CoverUploadTarget(context.Background(), "circle-1", "cover-1", "admin-1"); err != nil {
		t.Fatal(err)
	}
	if bucket.key != "circle-1/cover/cover-1" {
		t.Errorf("key = %q, want circle-1/cover/cover-1", bucket.key)
	}
	if bucket.maxBytes != maxCoverSize {
		t.Errorf("maxBytes = %d, want the cover cap", bucket.maxBytes)
	}
}

// Reading a cover is any member's. There is no row to check: every
// change mints a new id, so the id a member holds either has bytes
// behind it or does not.
func TestCoverURL_NeedsOnlyMembership(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{
		Store: &fakeStore{getMember: func(context.Context, string, string) (circles.Member, error) {
			return circles.Member{}, circles.ErrNotMember
		}},
		Blobs: bucket,
	}
	if _, err := service.CoverURL(context.Background(), "circle-1", "cover-1", "outsider"); !errors.Is(err, circles.ErrNotMember) {
		t.Fatalf("expected ErrNotMember, got %v", err)
	}

	service = &Service{Store: &fakeStore{getMember: roleIs(circles.RoleMember)}, Blobs: bucket}
	url, err := service.CoverURL(context.Background(), "circle-1", "cover-1", "member-1")
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://cdn.example/circle-1/cover/cover-1" {
		t.Errorf("url = %q", url)
	}
}

// Deleting a circle sweeps its whole prefix, cover and photos alike, and
// the trailing slash is what keeps it off a circle whose id starts the
// same way.
func TestDelete_SweepsTheCirclesOwnPrefix(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{
		Store: &fakeStore{
			getMember:    roleIs(circles.RoleAdmin),
			deleteCircle: func(context.Context, string) error { return nil },
		},
		Blobs: bucket,
	}

	if err := service.Delete(context.Background(), "circle-1", "admin-1"); err != nil {
		t.Fatal(err)
	}
	if len(bucket.swept) != 1 || bucket.swept[0] != "circle-1/" {
		t.Fatalf("swept %v, want [circle-1/]", bucket.swept)
	}
}
