package posts

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/circles"
)

type fakeStore struct {
	members  map[string]circles.Member
	circle   circles.Circle
	post     circles.Entry
	written  circles.Entry
	postErr  error
	deleted  string
	listed   circles.Page
	children int64
}

func (f *fakeStore) GetCircle(context.Context, string) (circles.Circle, error) {
	return f.circle, nil
}

func (f *fakeStore) GetMember(_ context.Context, _, accountID string) (circles.Member, error) {
	member, ok := f.members[accountID]
	if !ok {
		return circles.Member{}, circles.ErrNotMember
	}
	return member, nil
}

func (f *fakeStore) PutPost(_ context.Context, _ string, entry circles.Entry) (circles.Entry, error) {
	f.written = entry
	return entry, f.postErr
}

func (f *fakeStore) GetPost(context.Context, string, string, string) (circles.Entry, error) {
	return f.post, nil
}

func (f *fakeStore) DeletePost(_ context.Context, _, postID string) (circles.Entry, error) {
	f.deleted = postID
	return f.post, nil
}

func (f *fakeStore) SetVisibility(_ context.Context, _, _, visibility string) (circles.Entry, error) {
	entry := f.post
	entry.Visibility = visibility
	return entry, nil
}

func (f *fakeStore) ListChildren(context.Context, string, string) ([]circles.Comment, []circles.Reaction, error) {
	return nil, nil, nil
}

func (f *fakeStore) ListEntries(context.Context, string, string, circles.Cursor, int32) (circles.Page, error) {
	return f.listed, nil
}

func (f *fakeStore) CountEntries(context.Context, string, string) (int64, error) {
	return f.children, nil
}

func circleWith(keyVersion int64, members ...circles.Member) *fakeStore {
	byID := map[string]circles.Member{}
	for _, member := range members {
		byID[member.AccountID] = member
	}
	return &fakeStore{members: byID, circle: circles.Circle{ID: "circle-1", KeyVersion: keyVersion}}
}

func member(id string) circles.Member {
	return circles.Member{AccountID: id, Role: circles.RoleMember}
}

func admin(id string) circles.Member {
	return circles.Member{AccountID: id, Role: circles.RoleAdmin}
}

// A circle's entries are for the people in it, reads included.
func TestEveryOperationRefusesSomeoneOutsideTheCircle(t *testing.T) {
	store := circleWith(1, member("member-1"))
	service := &Service{Store: store}
	ctx := context.Background()

	if _, err := service.Put(ctx, "circle-1", "stranger", circles.Entry{KeyVersion: 1}); !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("put: expected ErrNotMember, got %v", err)
	}
	if _, err := service.Walk(ctx, "circle-1", "stranger", circles.Cursor{}, 10); !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("walk: expected ErrNotMember, got %v", err)
	}
	if _, _, err := service.Children(ctx, "circle-1", "post-1", "stranger"); !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("children: expected ErrNotMember, got %v", err)
	}
	if _, err := service.Count(ctx, "circle-1", "stranger", circles.TypePost); !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("count: expected ErrNotMember, got %v", err)
	}
}

// A post encrypted under a rotated-away key would be unreadable to
// everyone but its author, so it is refused rather than stored.
func TestPut_RefusesAKeyVersionThatHasBeenRotatedAway(t *testing.T) {
	store := circleWith(3, member("member-1"))
	service := &Service{Store: store}

	_, err := service.Put(context.Background(), "circle-1", "member-1", circles.Entry{ID: "post-1", KeyVersion: 2})
	if !errors.Is(err, circles.ErrStaleKeyVersion) {
		t.Fatalf("expected ErrStaleKeyVersion, got %v", err)
	}
	if store.written.ID != "" {
		t.Error("nothing should have been written")
	}
}

// The author is whoever is signed in, never what the request claims.
func TestPut_StampsTheCallerAsTheAuthor(t *testing.T) {
	store := circleWith(1, member("member-1"))
	service := &Service{Store: store}

	_, err := service.Put(context.Background(), "circle-1", "member-1", circles.Entry{
		ID: "post-1", KeyVersion: 1, AuthorID: "someone-else",
	})
	if err != nil {
		t.Fatal(err)
	}
	if store.written.AuthorID != "member-1" {
		t.Errorf("author = %q, want member-1", store.written.AuthorID)
	}
	if store.written.Type != circles.TypePost {
		t.Errorf("type = %q, want post", store.written.Type)
	}
}

// Deleting and hiding belong to the author, or to an admin. Nobody else
// can remove what someone else posted.
func TestDeleteAndVisibility_AreTheAuthorsOrAnAdmins(t *testing.T) {
	ctx := context.Background()

	t.Run("another member is refused", func(t *testing.T) {
		store := circleWith(1, member("author-1"), member("member-2"))
		store.post = circles.Entry{ID: "post-1", AuthorID: "author-1"}
		service := &Service{Store: store}

		if _, err := service.Delete(ctx, "circle-1", "post-1", "member-2"); !errors.Is(err, circles.ErrNotTheAuthor) {
			t.Errorf("delete: expected ErrNotTheAuthor, got %v", err)
		}
		if _, err := service.SetVisibility(ctx, "circle-1", "post-1", "member-2", "hidden"); !errors.Is(err, circles.ErrNotTheAuthor) {
			t.Errorf("visibility: expected ErrNotTheAuthor, got %v", err)
		}
	})

	t.Run("the author may", func(t *testing.T) {
		store := circleWith(1, member("author-1"))
		store.post = circles.Entry{ID: "post-1", AuthorID: "author-1"}
		service := &Service{Store: store}

		if _, err := service.Delete(ctx, "circle-1", "post-1", "author-1"); err != nil {
			t.Fatal(err)
		}
		if store.deleted != "post-1" {
			t.Error("expected the deletion to reach the store")
		}
	})

	t.Run("an admin may", func(t *testing.T) {
		store := circleWith(1, member("author-1"), admin("admin-1"))
		store.post = circles.Entry{ID: "post-1", AuthorID: "author-1"}
		service := &Service{Store: store}

		if _, err := service.Delete(ctx, "circle-1", "post-1", "admin-1"); err != nil {
			t.Fatal(err)
		}
		if store.deleted != "post-1" {
			t.Error("expected the deletion to reach the store")
		}
	})
}
