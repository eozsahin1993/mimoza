package posts

import (
	"context"
	"log/slog"

	"mimoza-relay/internal/blobs"
	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	PutPost(ctx context.Context, circleID string, entry circles.Entry) (circles.Entry, error)
	GetPost(ctx context.Context, circleID, postID, readerID string) (circles.Entry, error)
	DeletePost(ctx context.Context, circleID, postID string) (circles.Entry, error)
	SetVisibility(ctx context.Context, circleID, postID, visibility string) (circles.Entry, error)
	ListChildren(ctx context.Context, circleID, postID string) ([]circles.Comment, []circles.Reaction, error)
	ListEntries(ctx context.Context, circleID, readerID string, cursor circles.Cursor, limit int32) (circles.Page, error)
	CountEntries(ctx context.Context, circleID, entryType string) (int64, error)
}

// bucket is the blob storage. It takes keys, so where a photo lives is
// stated once, in photoKey.
type bucket interface {
	UploadTarget(ctx context.Context, key string, maxBytes int64) (blobs.UploadTarget, error)
	DownloadURL(ctx context.Context, key string) (string, error)
	Delete(ctx context.Context, key string) error
}

type Service struct {
	Store store
	// Blobs is nil in tests that do not care about bytes; a post with no
	// photo never reaches it either way.
	Blobs bucket
}

// UploadTarget is issued before the post exists on purpose: a crash in
// between leaves an orphan rather than a post pointing at bytes that
// never arrived.
func (s *Service) UploadTarget(ctx context.Context, circleID, postID, accountID string) (blobs.UploadTarget, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return blobs.UploadTarget{}, err
	}
	return s.Blobs.UploadTarget(ctx, photoKey(circleID, postID), maxPhotoSize)
}

// PhotoURL refuses a deleted post: edge invalidation is best-effort, so
// this is what actually stops the photo being fetched again.
func (s *Service) PhotoURL(ctx context.Context, circleID, postID, accountID string) (string, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return "", err
	}
	post, err := s.Store.GetPost(ctx, circleID, postID, accountID)
	if err != nil {
		return "", err
	}
	if !post.DeletedAt.IsZero() || !post.HasBlob {
		return "", circles.ErrEntryNotFound
	}
	return s.Blobs.DownloadURL(ctx, photoKey(circleID, postID))
}

// Put writes a post. The key version is checked against the circle's
// current one: a post encrypted under a key that has been rotated away
// would be unreadable to everyone but its author.
func (s *Service) Put(ctx context.Context, circleID, accountID string, entry circles.Entry) (circles.Entry, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return circles.Entry{}, err
	}
	circle, err := s.Store.GetCircle(ctx, circleID)
	if err != nil {
		return circles.Entry{}, err
	}
	if entry.KeyVersion != circle.KeyVersion {
		return circles.Entry{}, circles.ErrStaleKeyVersion
	}

	entry.AuthorID = accountID
	entry.Type = circles.TypePost
	return s.Store.PutPost(ctx, circleID, entry)
}

// Walk is one page of a stream. The cursor says which stream and where;
// this only checks that the caller is still in the circle.
func (s *Service) Walk(ctx context.Context, circleID, accountID string, cursor circles.Cursor, limit int32) (circles.Page, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return circles.Page{}, err
	}
	return s.Store.ListEntries(ctx, circleID, accountID, cursor, limit)
}

// Count is the completeness check: what a device compares its own count
// against before trusting that it has caught up.
func (s *Service) Count(ctx context.Context, circleID, accountID, entryType string) (int64, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return 0, err
	}
	return s.Store.CountEntries(ctx, circleID, entryType)
}

func (s *Service) Children(ctx context.Context, circleID, postID, accountID string) ([]circles.Comment, []circles.Reaction, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return nil, nil, err
	}
	return s.Store.ListChildren(ctx, circleID, postID)
}

// SetVisibility and Delete are the author's, or an admin's. Nobody else
// can hide or remove what someone else posted.
func (s *Service) SetVisibility(ctx context.Context, circleID, postID, accountID, visibility string) (circles.Entry, error) {
	if err := s.authorOrAdmin(ctx, circleID, postID, accountID); err != nil {
		return circles.Entry{}, err
	}
	return s.Store.SetVisibility(ctx, circleID, postID, visibility)
}

func (s *Service) Delete(ctx context.Context, circleID, postID, accountID string) (circles.Entry, error) {
	if err := s.authorOrAdmin(ctx, circleID, postID, accountID); err != nil {
		return circles.Entry{}, err
	}
	post, err := s.Store.DeletePost(ctx, circleID, postID)
	if err != nil {
		return circles.Entry{}, err
	}
	// Row first, bytes after: the row is what refuses a signed URL, so a
	// failure here leaks bytes nobody can ask for.
	if s.Blobs != nil && post.HasBlob {
		if err := s.Blobs.Delete(ctx, photoKey(circleID, postID)); err != nil {
			slog.ErrorContext(ctx, "deleted a post but not its photo",
				"reason", "blob_not_deleted", "error", err, "circleId", circleID, "entryId", postID)
		}
	}
	return post, nil
}

func (s *Service) authorOrAdmin(ctx context.Context, circleID, postID, accountID string) error {
	member, err := s.Store.GetMember(ctx, circleID, accountID)
	if err != nil {
		return err
	}
	post, err := s.Store.GetPost(ctx, circleID, postID, "")
	if err != nil {
		return err
	}
	if post.AuthorID != accountID && !member.IsAdmin() {
		return circles.ErrNotTheAuthor
	}
	return nil
}

// requireMember is how every read and write here starts: a circle's
// entries are for the people in it.
func (s *Service) requireMember(ctx context.Context, circleID, accountID string) error {
	_, err := s.Store.GetMember(ctx, circleID, accountID)
	return err
}
