package circle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"mimoza-relay/internal/circles"
)

// store is what this resource needs and nothing else, so a fake in a
// test is these methods and a later store method cannot widen what this
// slice can reach.
type store interface {
	CreateCircle(ctx context.Context, circle circles.Circle, founder circles.Member, sealed []byte) error
	ListMemberships(ctx context.Context, accountID string) ([]circles.Membership, error)
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	UpdateCircle(ctx context.Context, circleID, name, coverID, actorID string) (circles.Circle, error)
	DeleteCircle(ctx context.Context, circleID string) error
}

type Service struct {
	Store store
}

// Create mints the circle id rather than taking one: it is the relay's
// key space, and a client-chosen id could collide with a circle the
// caller is not in.
func (s *Service) Create(ctx context.Context, accountID, name string, sealed []byte) (circles.Circle, error) {
	circle := circles.Circle{
		ID:            newID(),
		Name:          name,
		KeyVersion:    1,
		RosterVersion: 1,
		CreatedBy:     accountID,
		CreatedAt:     time.Now(),
	}
	founder := circles.Member{
		AccountID:   accountID,
		Role:        circles.RoleAdmin,
		NotifyLevel: circles.NotifyAll,
	}
	if err := s.Store.CreateCircle(ctx, circle, founder, sealed); err != nil {
		return circles.Circle{}, err
	}
	return circle, nil
}

func newID() string {
	buf := make([]byte, 16)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// requireAdmin is the check every write in this slice starts with: the
// caller is in the circle, and is an admin of it.
func (s *Service) requireAdmin(ctx context.Context, circleID, accountID string) error {
	member, err := s.Store.GetMember(ctx, circleID, accountID)
	if err != nil {
		return err
	}
	if !member.IsAdmin() {
		return circles.ErrNotAdmin
	}
	return nil
}

// Patch sets the name, the cover, or both. A new cover is a new id, so
// its bytes sit at a key nothing has cached.
func (s *Service) Patch(ctx context.Context, circleID, accountID, name, coverID string) (circles.Circle, error) {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return circles.Circle{}, err
	}
	return s.Store.UpdateCircle(ctx, circleID, name, coverID, accountID)
}

// Delete ends a circle for everyone in it.
func (s *Service) Delete(ctx context.Context, circleID, accountID string) error {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return err
	}
	return s.Store.DeleteCircle(ctx, circleID)
}

// List is where a sync starts: every circle this account is in, with the
// versions a device checks its own against.
func (s *Service) List(ctx context.Context, accountID string) ([]circles.Membership, error) {
	return s.Store.ListMemberships(ctx, accountID)
}
