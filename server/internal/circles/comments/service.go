package comments

import (
	"context"

	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	GetPost(ctx context.Context, circleID, postID, readerID string) (circles.Entry, error)
	ListChildren(ctx context.Context, circleID, postID string) ([]circles.Comment, []circles.Reaction, error)
	AddComment(ctx context.Context, circleID string, comment circles.Comment) (circles.Entry, error)
	DeleteComment(ctx context.Context, circleID, postID, commentID string) (circles.Entry, error)
}

type Service struct {
	Store store
}

// Add writes a comment and hands back the post it changed, so the device
// that wrote it can replace its copy without waiting for a sync.
func (s *Service) Add(ctx context.Context, circleID, accountID string, comment circles.Comment) (circles.Entry, error) {
	if _, err := s.Store.GetMember(ctx, circleID, accountID); err != nil {
		return circles.Entry{}, err
	}
	circle, err := s.Store.GetCircle(ctx, circleID)
	if err != nil {
		return circles.Entry{}, err
	}
	if comment.KeyVersion != circle.KeyVersion {
		return circles.Entry{}, circles.ErrStaleKeyVersion
	}

	comment.AuthorID = accountID
	return s.Store.AddComment(ctx, circleID, comment)
}

// Delete is the comment's author or an admin. The post's author has no
// say: a comment belongs to whoever wrote it.
func (s *Service) Delete(ctx context.Context, circleID, postID, commentID, accountID string) (circles.Entry, error) {
	member, err := s.Store.GetMember(ctx, circleID, accountID)
	if err != nil {
		return circles.Entry{}, err
	}

	comments, _, err := s.Store.ListChildren(ctx, circleID, postID)
	if err != nil {
		return circles.Entry{}, err
	}
	for _, comment := range comments {
		if comment.ID != commentID {
			continue
		}
		if comment.AuthorID != accountID && !member.IsAdmin() {
			return circles.Entry{}, circles.ErrNotTheAuthor
		}
		if !comment.DeletedAt.IsZero() {
			// Already gone: hand back the post rather than deleting twice.
			return s.Store.GetPost(ctx, circleID, postID, "")
		}
		return s.Store.DeleteComment(ctx, circleID, postID, commentID)
	}
	return circles.Entry{}, circles.ErrEntryNotFound
}
