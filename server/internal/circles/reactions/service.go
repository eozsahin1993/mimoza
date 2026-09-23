package reactions

import (
	"context"

	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	SetReaction(ctx context.Context, circleID string, reaction circles.Reaction) (circles.Entry, error)
	ClearReaction(ctx context.Context, circleID, postID, accountID string) (circles.Entry, error)
}

type Service struct {
	Store store
	// Notify is nil in tests that do not care who hears about a write.
	Notify circles.Notifier
}

// Set replaces this member's reaction. The tag is what the relay counts
// by; it never learns which emoji it stands for.
func (s *Service) Set(ctx context.Context, circleID, accountID string, reaction circles.Reaction) (circles.Entry, error) {
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
	post, err := s.Store.SetReaction(ctx, circleID, reaction)
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

func (s *Service) Clear(ctx context.Context, circleID, postID, accountID string) (circles.Entry, error) {
	if _, err := s.Store.GetMember(ctx, circleID, accountID); err != nil {
		return circles.Entry{}, err
	}
	return s.Store.ClearReaction(ctx, circleID, postID, accountID)
}
