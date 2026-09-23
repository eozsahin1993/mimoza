package invites

import (
	"context"
	"time"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	ListMembers(ctx context.Context, circleID string) ([]circles.Member, error)
	CreateInvite(ctx context.Context, invite circles.Invite) error
	GetInvite(ctx context.Context, code string) (circles.Invite, error)
	ListInvites(ctx context.Context, circleID string) ([]circles.Invite, error)
	RevokeInvite(ctx context.Context, circleID, code string) error
}

// profiles names whoever shared the code. Someone deciding whether to
// ask should see a person, not an account id.
type profiles interface {
	GetProfile(ctx context.Context, accountID string) (accounts.Profile, error)
}

type Service struct {
	Store store
	// Retention is how long a new code lasts. A code that never expired
	// would be a standing way in, long after whoever shared it forgot.
	Retention time.Duration
	Profiles  profiles
}

// Preview is what a circle looks like from outside: enough to decide
// whether to ask, and nothing about who is in it. InvitedBy is a
// display name, not an id.
type Preview struct {
	CircleID    string
	Name        string
	MemberCount int
	InvitedBy   string
}

func (s *Service) Create(ctx context.Context, circleID, accountID string) (circles.Invite, error) {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return circles.Invite{}, err
	}

	retention := s.Retention
	if retention <= 0 {
		// A code with no lifetime would expire the moment it was made.
		retention = time.Duration(circles.DefaultInviteRetentionDays) * 24 * time.Hour
	}

	now := time.Now()
	invite := circles.Invite{
		Code:      newCode(),
		CircleID:  circleID,
		CreatedBy: accountID,
		CreatedAt: now,
		ExpiresAt: now.Add(retention),
	}
	if err := s.Store.CreateInvite(ctx, invite); err != nil {
		return circles.Invite{}, err
	}
	return invite, nil
}

// List is every admin's, not just the code's author: an admin who did
// not create a code still has to be able to see and revoke it.
func (s *Service) List(ctx context.Context, circleID, accountID string) ([]circles.Invite, error) {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return nil, err
	}
	return s.Store.ListInvites(ctx, circleID)
}

func (s *Service) Revoke(ctx context.Context, circleID, code, accountID string) error {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return err
	}
	return s.Store.RevokeInvite(ctx, circleID, code)
}

// Preview answers to anyone holding the code, member or not: it is how
// someone decides whether this is the circle they were invited to.
func (s *Service) Preview(ctx context.Context, code string) (Preview, error) {
	invite, err := s.Store.GetInvite(ctx, code)
	if err != nil {
		return Preview{}, err
	}
	circle, err := s.Store.GetCircle(ctx, invite.CircleID)
	if err != nil {
		return Preview{}, err
	}
	roster, err := s.Store.ListMembers(ctx, invite.CircleID)
	if err != nil {
		return Preview{}, err
	}
	// Nameless rather than failing: a profile that cannot be read is no
	// reason to refuse someone a look at the circle.
	invitedBy := ""
	if s.Profiles != nil {
		if profile, err := s.Profiles.GetProfile(ctx, invite.CreatedBy); err == nil {
			invitedBy = profile.Name
		}
	}
	return Preview{
		CircleID:    circle.ID,
		Name:        circle.Name,
		MemberCount: len(roster),
		InvitedBy:   invitedBy,
	}, nil
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
