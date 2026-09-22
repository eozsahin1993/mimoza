package blobs

import (
	"context"
	"errors"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
)

type fakeStore struct {
	members map[string]circles.Member
	posts   map[string]circles.Entry
}

func (f *fakeStore) GetMember(_ context.Context, _, accountID string) (circles.Member, error) {
	member, ok := f.members[accountID]
	if !ok {
		return circles.Member{}, circles.ErrNotMember
	}
	return member, nil
}

func (f *fakeStore) GetPost(_ context.Context, _, postID, _ string) (circles.Entry, error) {
	post, ok := f.posts[postID]
	if !ok {
		return circles.Entry{}, circles.ErrEntryNotFound
	}
	return post, nil
}

// fakeBucket records the key it was asked about, which is the whole of
// what this slice decides once the caller is allowed through.
type fakeBucket struct {
	key string
	err error
}

func (f *fakeBucket) UploadTarget(_ context.Context, key string) (circles.UploadTarget, error) {
	f.key = key
	if f.err != nil {
		return circles.UploadTarget{}, f.err
	}
	return circles.UploadTarget{URL: "https://bucket.example/" + key}, nil
}

func (f *fakeBucket) DownloadURL(_ context.Context, key string) (string, error) {
	f.key = key
	if f.err != nil {
		return "", f.err
	}
	return "https://cdn.example/" + key, nil
}

func circleWith(members map[string]circles.Member, posts map[string]circles.Entry) *fakeStore {
	return &fakeStore{members: members, posts: posts}
}

func admin(id string) circles.Member {
	return circles.Member{AccountID: id, Role: circles.RoleAdmin}
}

func member(id string) circles.Member {
	return circles.Member{AccountID: id, Role: circles.RoleMember}
}

func TestUploadTarget_IsForMembersOnly(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{
		Store:  circleWith(map[string]circles.Member{"member-1": member("member-1")}, nil),
		Bucket: bucket,
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
}

// Only an admin can point a circle at a new cover, so only an admin may
// put one in the bucket. Otherwise a member could leave objects at keys
// nothing will ever name.
func TestCoverUploadTarget_IsForAdminsOnly(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{
		Store: circleWith(map[string]circles.Member{
			"admin-1":  admin("admin-1"),
			"member-2": member("member-2"),
		}, nil),
		Bucket: bucket,
	}

	if _, err := service.CoverUploadTarget(context.Background(), "circle-1", "cover-1", "member-2"); !errors.Is(err, circles.ErrNotAdmin) {
		t.Fatalf("expected ErrNotAdmin, got %v", err)
	}
	if _, err := service.CoverUploadTarget(context.Background(), "circle-1", "cover-1", "admin-1"); err != nil {
		t.Fatal(err)
	}
	if bucket.key != "circle-1/cover/cover-1" {
		t.Errorf("key = %q, want circle-1/cover/cover-1", bucket.key)
	}
}

// Invalidating the edge is best-effort, so refusing to sign is what
// actually stops a deleted photo being fetched again.
func TestDownloadURL_RefusesADeletedPost(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{
		Store: circleWith(
			map[string]circles.Member{"member-1": member("member-1")},
			map[string]circles.Entry{
				"live":    {ID: "live", HasBlob: true},
				"deleted": {ID: "deleted", HasBlob: true, DeletedAt: time.Now()},
				"textual": {ID: "textual"},
			}),
		Bucket: bucket,
	}

	if _, err := service.DownloadURL(context.Background(), "circle-1", "live", "member-1"); err != nil {
		t.Fatal(err)
	}
	if bucket.key != "circle-1/live" {
		t.Errorf("key = %q, want circle-1/live", bucket.key)
	}

	for _, postID := range []string{"deleted", "textual", "missing"} {
		if _, err := service.DownloadURL(context.Background(), "circle-1", postID, "member-1"); !errors.Is(err, circles.ErrEntryNotFound) {
			t.Errorf("%s: expected ErrEntryNotFound, got %v", postID, err)
		}
	}
}

// A cover has no row to check: every change mints a new id, so the id a
// member holds either has bytes behind it or does not.
func TestCoverDownloadURL_NeedsOnlyMembership(t *testing.T) {
	bucket := &fakeBucket{}
	service := &Service{
		Store:  circleWith(map[string]circles.Member{"member-1": member("member-1")}, nil),
		Bucket: bucket,
	}

	if _, err := service.CoverDownloadURL(context.Background(), "circle-1", "cover-1", "outsider"); !errors.Is(err, circles.ErrNotMember) {
		t.Fatalf("expected ErrNotMember, got %v", err)
	}
	url, err := service.CoverDownloadURL(context.Background(), "circle-1", "cover-1", "member-1")
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://cdn.example/circle-1/cover/cover-1" {
		t.Errorf("url = %q", url)
	}
}
