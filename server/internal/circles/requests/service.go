package requests

import (
	"context"
	"errors"
	"time"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	ListMembers(ctx context.Context, circleID string) ([]circles.Member, error)
	GetInvite(ctx context.Context, code string) (circles.Invite, error)
	CreateRequest(ctx context.Context, request circles.Request) error
	ListRequests(ctx context.Context, circleID string) ([]circles.Request, error)
	ApproveRequest(ctx context.Context, circleID, requestID, actorID string, member circles.Member, sealed circles.SealedKeys, name string, expectedVersion int64) error
	DenyRequest(ctx context.Context, circleID, requestID string) error
}

// profiles is who the account ids on these requests are. An admin
// answering a request sees a name and a face, and the key the requester
// is admitted with comes from their account rather than from the body
// of the ask.
type profiles interface {
	GetProfile(ctx context.Context, accountID string) (accounts.Profile, error)
	GetProfiles(ctx context.Context, accountIDs []string) (map[string]accounts.Profile, error)
}

// Pending is one request with the person behind it. A name and no
// picture: the asker holds no content key yet, so there is nothing they
// could have sealed a face to.
type Pending struct {
	circles.Request
	Name string
}

type Service struct {
	Store store
	// Notify is nil in tests that do not care who hears about a write.
	Notify circles.Notifier
	// Profiles names the requester, and holds the public key their copy
	// of the content keys is sealed to.
	Profiles profiles
	// Retention is how long an unanswered request lasts, matching the
	// code that allowed it.
	Retention time.Duration
}

// Create is someone asking to join, holding a code. The key an approver
// seals the circle's keys to is read from the requester's account rather
// than taken from the ask: the account is where that key lives, and a
// request carrying its own copy is a second place for it to go stale.
func (s *Service) Create(ctx context.Context, code, accountID string) (circles.Request, error) {
	invite, err := s.Store.GetInvite(ctx, code)
	if err != nil {
		return circles.Request{}, err
	}
	// Already in: nothing to ask for, and an admin should not have to
	// answer it. Anything other than "not a member" is a storage failure,
	// which must not read as permission to ask.
	switch _, err := s.Store.GetMember(ctx, invite.CircleID, accountID); {
	case err == nil:
		return circles.Request{}, circles.ErrAlreadyExists
	case !errors.Is(err, circles.ErrNotMember):
		return circles.Request{}, err
	}

	profile, err := s.Profiles.GetProfile(ctx, accountID)
	if err != nil {
		return circles.Request{}, err
	}
	// Without a published key there is nothing to seal the circle to, and
	// the approval would admit someone who cannot read a word of it.
	if len(profile.PublicKey) == 0 {
		return circles.Request{}, circles.ErrNoPublicKey
	}

	now := time.Now()
	request := circles.Request{
		// One request per account per circle: asking twice replaces the
		// first ask rather than queueing a second for an admin to answer.
		ID:        circles.RequestID(accountID),
		CircleID:  invite.CircleID,
		AccountID: accountID,
		PublicKey: profile.PublicKey,
		Status:    circles.RequestPending,
		CreatedAt: now,
		ExpiresAt: now.Add(s.Retention),
	}
	if err := s.Store.CreateRequest(ctx, request); err != nil {
		return circles.Request{}, err
	}
	// Only the admins: they are the ones who can answer it.
	if s.Notify != nil {
		roster, err := s.Store.ListMembers(ctx, invite.CircleID)
		if err == nil {
			s.Notify.Notify(ctx, circles.Notification{
				Kind: circles.NotifyJoinRequest, CircleID: invite.CircleID,
				ActorID: accountID, Only: adminsOf(roster),
			})
		}
	}
	return request, nil
}

// adminsOf is who answers a join request.
func adminsOf(roster []circles.Member) []string {
	var admins []string
	for _, member := range roster {
		if member.IsAdmin() {
			admins = append(admins, member.AccountID)
		}
	}
	return admins
}

// List is any admin's, not only the code's author: an admin who did not
// hand out the code still has to be able to answer what it produced.
func (s *Service) List(ctx context.Context, circleID, accountID string) ([]Pending, error) {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return nil, err
	}
	requests, err := s.Store.ListRequests(ctx, circleID)
	if err != nil {
		return nil, err
	}

	ids := make([]string, 0, len(requests))
	for _, request := range requests {
		ids = append(ids, request.AccountID)
	}
	identities, err := s.Profiles.GetProfiles(ctx, ids)
	if err != nil {
		return nil, err
	}

	pending := make([]Pending, 0, len(requests))
	for _, request := range requests {
		pending = append(pending, Pending{
			Request: request,
			Name:    identities[request.AccountID].Name,
		})
	}
	return pending, nil
}

// Approve admits the requester with every content key sealed to them by
// the approving admin's own device. The relay checks the set covers
// every version; it cannot check the seals themselves.
func (s *Service) Approve(ctx context.Context, circleID, requestID, accountID string, sealed circles.SealedKeys) error {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return err
	}
	circle, err := s.Store.GetCircle(ctx, circleID)
	if err != nil {
		return err
	}

	requests, err := s.Store.ListRequests(ctx, circleID)
	if err != nil {
		return err
	}
	for _, request := range requests {
		if request.ID != requestID {
			continue
		}
		if request.Status != circles.RequestPending {
			return circles.ErrRequestNotFound
		}
		// The name is stamped now, so the wall can still say who joined
		// after they have left again or deleted their account. Fetched
		// here rather than trusted from the request: it is also the
		// freshest read of the account's public key, and sealed was built
		// against the key snapshotted on the ask, which the requester may
		// have since rotated away from — sealing to it would admit a
		// member who cannot open a word of what they were just given.
		name := ""
		if profile, err := s.Profiles.GetProfile(ctx, request.AccountID); err == nil {
			name = profile.Name
			if string(profile.PublicKey) != string(request.PublicKey) {
				return circles.ErrPublicKeyChanged
			}
		}
		member := circles.Member{
			AccountID:   request.AccountID,
			Role:        circles.RoleMember,
			NotifyLevel: circles.NotifyAll,
		}
		if err := s.Store.ApproveRequest(ctx, circleID, requestID, accountID, member, sealed, name, circle.KeyVersion); err != nil {
			return err
		}
		if s.Notify != nil {
			s.Notify.Notify(ctx, circles.Notification{
				Kind: circles.NotifyApproved, CircleID: circleID,
				ActorID: accountID, Only: []string{request.AccountID},
			})
		}
		return nil
	}
	return circles.ErrRequestNotFound
}

func (s *Service) Deny(ctx context.Context, circleID, requestID, accountID string) error {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return err
	}
	return s.Store.DenyRequest(ctx, circleID, requestID)
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

// requestID is derived from the account rather than random, which is
// what makes asking twice replace the first ask instead of queueing a
// second for an admin to answer. A hash, so two accounts cannot land on
// the same id and overwrite each other's ask.
