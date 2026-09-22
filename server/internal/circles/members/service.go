package members

import (
	"context"

	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	ListMembers(ctx context.Context, circleID string) ([]circles.Member, error)
	GetSealedKeys(ctx context.Context, circleID, accountID string) (circles.SealedKeys, error)
	SetRole(ctx context.Context, circleID, accountID, role, actorID string) error
	SetNotifyLevel(ctx context.Context, circleID, accountID, level string) error
	RemoveMember(ctx context.Context, circleID, accountID, actorID string, expectedVersion int64, sealed map[string][]byte) error
	LeaveCircle(ctx context.Context, circleID, accountID string) error
	ReplaceSealedKeys(ctx context.Context, circleID, accountID string, sealed circles.SealedKeys) error
}

type Service struct {
	Store store
}

// Roster is the circle's members and the caller's own sealed keys: one
// call, because a device that has just learned the roster moved almost
// always needs both.
func (s *Service) Roster(ctx context.Context, circleID, accountID string) (circles.Circle, []circles.Member, circles.SealedKeys, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return circles.Circle{}, nil, nil, err
	}
	circle, err := s.Store.GetCircle(ctx, circleID)
	if err != nil {
		return circles.Circle{}, nil, nil, err
	}
	roster, err := s.Store.ListMembers(ctx, circleID)
	if err != nil {
		return circles.Circle{}, nil, nil, err
	}
	keys, err := s.Store.GetSealedKeys(ctx, circleID, accountID)
	if err != nil {
		return circles.Circle{}, nil, nil, err
	}
	return circle, roster, keys, nil
}

// SetRole is an admin's to make; SetNotifyLevel is only ever your own.
// Both arrive on the same route, so the rule is per field rather than
// per route.
func (s *Service) SetRole(ctx context.Context, circleID, subjectID, role, actorID string) error {
	if err := s.requireAdmin(ctx, circleID, actorID); err != nil {
		return err
	}
	if err := s.requireMember(ctx, circleID, subjectID); err != nil {
		return err
	}
	// Demoting the last admin would leave nobody able to rotate a key or
	// admit anyone ever again.
	if role == circles.RoleMember {
		if err := s.wouldStrandCircle(ctx, circleID, subjectID); err != nil {
			return err
		}
	}
	return s.Store.SetRole(ctx, circleID, subjectID, role, actorID)
}

func (s *Service) SetNotifyLevel(ctx context.Context, circleID, subjectID, level, actorID string) error {
	if subjectID != actorID {
		return circles.ErrNotTheAuthor
	}
	return s.Store.SetNotifyLevel(ctx, circleID, subjectID, level)
}

// Remove takes a member out and rotates the content key. The caller
// supplies the new key sealed to everyone who stays; the store refuses
// anything that does not cover them all.
func (s *Service) Remove(ctx context.Context, circleID, subjectID, actorID string, expectedVersion int64, sealed map[string][]byte) error {
	if err := s.requireAdmin(ctx, circleID, actorID); err != nil {
		return err
	}
	if subjectID == actorID {
		// Removing yourself is leaving, which does not rotate.
		return circles.ErrNotTheAuthor
	}
	return s.Store.RemoveMember(ctx, circleID, subjectID, actorID, expectedVersion, sealed)
}

// Leave is never refused for long: the last admin has to hand the role
// on first, but nobody is held in a circle.
func (s *Service) Leave(ctx context.Context, circleID, accountID string) error {
	if err := s.wouldStrandCircle(ctx, circleID, accountID); err != nil {
		return err
	}
	return s.Store.LeaveCircle(ctx, circleID, accountID)
}

// Rewrap is one member resealing the content keys to another member's
// new public key, after that member replaced their keypair. Any member
// may do it: they all hold the same keys, and the sealing happens on
// their device.
func (s *Service) Rewrap(ctx context.Context, circleID, subjectID, actorID string, sealed circles.SealedKeys) error {
	if err := s.requireMember(ctx, circleID, actorID); err != nil {
		return err
	}
	if err := s.requireMember(ctx, circleID, subjectID); err != nil {
		return err
	}
	// The whole map is replaced, so a missing version is not "left
	// alone", it is gone: every version this circle has ever had must be
	// in here, or the subject loses the history sealed under it.
	circle, err := s.Store.GetCircle(ctx, circleID)
	if err != nil {
		return err
	}
	for version := int64(1); version <= circle.KeyVersion; version++ {
		if len(sealed[version]) == 0 {
			return circles.ErrIncompleteKeys
		}
	}
	return s.Store.ReplaceSealedKeys(ctx, circleID, subjectID, sealed)
}

// wouldStrandCircle reports whether this account is the only admin left
// while others remain, which is the one case a departure or demotion has
// to refuse.
func (s *Service) wouldStrandCircle(ctx context.Context, circleID, accountID string) error {
	roster, err := s.Store.ListMembers(ctx, circleID)
	if err != nil {
		return err
	}
	admins, others := 0, 0
	for _, member := range roster {
		if member.IsAdmin() {
			admins++
		}
		if member.AccountID != accountID {
			others++
		}
	}
	self, err := s.Store.GetMember(ctx, circleID, accountID)
	if err != nil {
		return err
	}
	if self.IsAdmin() && admins == 1 && others > 0 {
		return circles.ErrWouldEmptyAdmins
	}
	return nil
}

// requireMember and requireAdmin are how every operation in this slice
// starts: they turn "who is calling" into the error a caller sees.
func (s *Service) requireMember(ctx context.Context, circleID, accountID string) error {
	_, err := s.Store.GetMember(ctx, circleID, accountID)
	return err
}

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
