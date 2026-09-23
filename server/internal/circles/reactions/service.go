package reactions

import (
	"context"

	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	Add(ctx context.Context, circleID string, reaction circles.Reaction) (circles.Entry, error)
	Remove(ctx context.Context, circleID, postID, accountID, tag string) (circles.Entry, error)
}

type Service struct {
	Store store
	// Notify is nil in tests that do not care who hears about a write.
	Notify circles.Notifier
}

// Add records one of this member's reactions. The tag is what the relay
// counts by; it never learns which emoji it stands for.
func (s *Service) Add(ctx context.Context, circleID, accountID string, reaction circles.Reaction) (circles.Entry, error) {
	if _, err := s.Store.GetMember(ctx, circleID, accountID); err != nil {
		return circles.Entry{}, err
	}
	circle, err := s.Store.GetCircle(ctx, circleID)
	if err != nil {
		return circles.Entry{}, err
	}
	if reaction.KeyVersion != circle.KeyVersion {
		return circles.Entry{}, circles.ErrStaleKeyVersion
	}

	reaction.AccountID = accountID
	post, err := s.Store.Add(ctx, circleID, reaction)
	if err != nil {
		return circles.Entry{}, err
	}
	if s.Notify != nil {
		s.Notify.Notify(ctx, circles.Notification{
			Kind: circles.NotifyReaction, CircleID: circleID, ActorID: accountID,
			ParentID: reaction.PostID, AuthorID: post.AuthorID,
		})
	}
	return post, nil
}

// Remove takes one reaction back, named by its tag: a member may hold
// several, so "mine" no longer says which.
func (s *Service) Remove(ctx context.Context, circleID, postID, accountID, tag string) (circles.Entry, error) {
	if _, err := s.Store.GetMember(ctx, circleID, accountID); err != nil {
		return circles.Entry{}, err
	}
	return s.Store.Remove(ctx, circleID, postID, accountID, tag)
}
