package requests

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	GetInvite(ctx context.Context, code string) (circles.Invite, error)
	CreateRequest(ctx context.Context, request circles.Request) error
	ListRequests(ctx context.Context, circleID string) ([]circles.Request, error)
	ApproveRequest(ctx context.Context, circleID, requestID, actorID string, member circles.Member, sealed circles.SealedKeys, name string) error
	DenyRequest(ctx context.Context, circleID, requestID string) error
}

type Service struct {
	Store store
	// Retention is how long an unanswered request lasts, matching the
	// code that allowed it.
	Retention time.Duration
}

// Create is someone asking to join, holding a code. The public key they
// send is what an approver seals the circle's keys to, so a request is
// also how a joiner says where to put them.
func (s *Service) Create(ctx context.Context, code, accountID string, publicKey []byte) (circles.Request, error) {
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

	now := time.Now()
	request := circles.Request{
		// One request per account per circle: asking twice replaces the
		// first ask rather than queueing a second for an admin to answer.
		ID:        requestID(accountID),
		CircleID:  invite.CircleID,
		AccountID: accountID,
		PublicKey: publicKey,
		Status:    circles.RequestPending,
		CreatedAt: now,
		ExpiresAt: now.Add(s.Retention),
	}
	if err := s.Store.CreateRequest(ctx, request); err != nil {
		return circles.Request{}, err
	}
	return request, nil
}

// List is any admin's, not only the code's author: an admin who did not
// hand out the code still has to be able to answer what it produced.
func (s *Service) List(ctx context.Context, circleID, accountID string) ([]circles.Request, error) {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return nil, err
	}
	return s.Store.ListRequests(ctx, circleID)
}

// Approve admits the requester with every content key sealed to them by
// the approving admin's own device. The relay checks the set covers
// every version; it cannot check the seals themselves.
func (s *Service) Approve(ctx context.Context, circleID, requestID, accountID string, sealed circles.SealedKeys) error {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
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
		member := circles.Member{
			AccountID:   request.AccountID,
			Role:        circles.RoleMember,
			NotifyLevel: circles.NotifyAll,
		}
		return s.Store.ApproveRequest(ctx, circleID, requestID, accountID, member, sealed, "")
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
func requestID(accountID string) string {
	sum := sha256.Sum256([]byte(accountID))
	return hex.EncodeToString(sum[:16])
}
