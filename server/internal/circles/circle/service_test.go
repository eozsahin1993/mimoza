package circle

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/circles"
)

// fakeStore answers only what a test sets. An unset method means the
// test did not expect that call, and says so rather than returning a
// zero value that quietly changes what is being tested.
type fakeStore struct {
	created         circles.Circle
	founder         circles.Member
	createCircle    func(ctx context.Context, circle circles.Circle, founder circles.Member, sealed []byte) error
	getCircle       func(ctx context.Context, circleID string) (circles.Circle, error)
	getMember       func(ctx context.Context, circleID, accountID string) (circles.Member, error)
	updateCircle    func(ctx context.Context, circleID, name, coverID, actorID string) (circles.Circle, error)
	deleteCircle    func(ctx context.Context, circleID string) error
	listMemberships func(ctx context.Context, accountID string) ([]circles.Membership, error)
}

func (f *fakeStore) ListMemberships(ctx context.Context, accountID string) ([]circles.Membership, error) {
	if f.listMemberships == nil {
		panic("ListMemberships was not expected")
	}
	return f.listMemberships(ctx, accountID)
}

func (f *fakeStore) CreateCircle(ctx context.Context, circle circles.Circle, founder circles.Member, sealed []byte) error {
	f.created, f.founder = circle, founder
	if f.createCircle == nil {
		return nil
	}
	return f.createCircle(ctx, circle, founder, sealed)
}

func (f *fakeStore) GetCircle(ctx context.Context, circleID string) (circles.Circle, error) {
	if f.getCircle == nil {
		panic("GetCircle was not expected")
	}
	return f.getCircle(ctx, circleID)
}

func (f *fakeStore) GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error) {
	if f.getMember == nil {
		panic("GetMember was not expected")
	}
	return f.getMember(ctx, circleID, accountID)
}

func (f *fakeStore) UpdateCircle(ctx context.Context, circleID, name, coverID, actorID string) (circles.Circle, error) {
	if f.updateCircle == nil {
		panic("UpdateCircle was not expected")
	}
	return f.updateCircle(ctx, circleID, name, coverID, actorID)
}

func (f *fakeStore) DeleteCircle(ctx context.Context, circleID string) error {
	if f.deleteCircle == nil {
		panic("DeleteCircle was not expected")
	}
	return f.deleteCircle(ctx, circleID)
}

func admin(circles.Member, error) func(context.Context, string, string) (circles.Member, error) {
	return func(context.Context, string, string) (circles.Member, error) {
		return circles.Member{Role: circles.RoleAdmin}, nil
	}
}

// The founder is an admin from the first moment: nobody else can make
// them one, and a circle with no admin can never rotate a key again.
func TestCreate_MakesTheFounderAnAdmin(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store}

	circle, err := service.Create(context.Background(), "account-1", "Family", []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
	if store.founder.Role != circles.RoleAdmin {
		t.Errorf("founder role = %q, want admin", store.founder.Role)
	}
	if store.founder.AccountID != "account-1" {
		t.Errorf("founder = %q, want account-1", store.founder.AccountID)
	}
	if circle.ID == "" || circle.KeyVersion != 1 {
		t.Errorf("expected a circle with an id at key version 1, got %+v", circle)
	}
}

// Two circles made in the same breath must not share an id.
func TestCreate_MintsADistinctIDEachTime(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store}

	first, err := service.Create(context.Background(), "account-1", "Family", []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Create(context.Background(), "account-1", "Friends", []byte("sealed"))
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Errorf("both circles got the id %q", first.ID)
	}
}

func TestPatchAndDelete_RefuseAMemberWhoIsNotAnAdmin(t *testing.T) {
	member := func(context.Context, string, string) (circles.Member, error) {
		return circles.Member{Role: circles.RoleMember}, nil
	}

	t.Run("patch", func(t *testing.T) {
		service := &Service{Store: &fakeStore{getMember: member}}
		if _, err := service.Patch(context.Background(), "circle-1", "account-2", "New name", ""); !errors.Is(err, circles.ErrNotAdmin) {
			t.Errorf("expected ErrNotAdmin, got %v", err)
		}
	})
	t.Run("delete", func(t *testing.T) {
		service := &Service{Store: &fakeStore{getMember: member}}
		if err := service.Delete(context.Background(), "circle-1", "account-2"); !errors.Is(err, circles.ErrNotAdmin) {
			t.Errorf("expected ErrNotAdmin, got %v", err)
		}
	})
}

// Someone outside the circle gets the same answer as a stranger, not a
// hint that the circle exists.
func TestPatch_RefusesSomeoneWhoIsNotInTheCircle(t *testing.T) {
	service := &Service{Store: &fakeStore{
		getMember: func(context.Context, string, string) (circles.Member, error) {
			return circles.Member{}, circles.ErrNotMember
		},
	}}

	if _, err := service.Patch(context.Background(), "circle-1", "stranger", "New name", ""); !errors.Is(err, circles.ErrNotMember) {
		t.Errorf("expected ErrNotMember, got %v", err)
	}
}

func TestPatch_PassesBothFieldsThrough(t *testing.T) {
	var gotName, gotCover string
	service := &Service{Store: &fakeStore{
		getMember: admin(circles.Member{}, nil),
		updateCircle: func(_ context.Context, _, name, coverID, _ string) (circles.Circle, error) {
			gotName, gotCover = name, coverID
			return circles.Circle{Name: name, CoverID: coverID}, nil
		},
	}}

	if _, err := service.Patch(context.Background(), "circle-1", "admin-1", "New name", "cover-9"); err != nil {
		t.Fatal(err)
	}
	if gotName != "New name" || gotCover != "cover-9" {
		t.Errorf("store got (%q, %q), want (New name, cover-9)", gotName, gotCover)
	}
}

// The list is the caller's own, whoever they are: the session says which
// account, and there is no path to another's.
func TestList_ReturnsEveryCircleTheCallerIsIn(t *testing.T) {
	service := &Service{Store: &fakeStore{
		listMemberships: func(_ context.Context, accountID string) ([]circles.Membership, error) {
			if accountID != "account-1" {
				t.Errorf("store asked for %q, want account-1", accountID)
			}
			return []circles.Membership{
				{Circle: circles.Circle{ID: "circle-1"}, Role: circles.RoleAdmin},
				{Circle: circles.Circle{ID: "circle-2"}, Role: circles.RoleMember},
			}, nil
		},
	}}

	memberships, err := service.List(context.Background(), "account-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 2 {
		t.Fatalf("got %d circles, want 2", len(memberships))
	}
}
