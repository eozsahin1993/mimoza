package blobs

import (
	"context"

	"mimoza-relay/internal/circles"
)

type store interface {
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	GetPost(ctx context.Context, circleID, postID, callerID string) (circles.Entry, error)
}

// bucket is the blob storage itself. It takes keys rather than ids
// because it stores two shapes and knows nothing about either: which
// key a post or a cover lives at is this slice's business.
type bucket interface {
	UploadTarget(ctx context.Context, key string) (circles.UploadTarget, error)
	DownloadURL(ctx context.Context, key string) (string, error)
}

type Service struct {
	Store  store
	Bucket bucket
}

// UploadTarget is where a device sends a post's encrypted photo. It is
// issued before the post exists, on purpose: uploading first means a
// crash in between leaves an orphaned blob rather than a post pointing
// at bytes that never arrived.
func (s *Service) UploadTarget(ctx context.Context, circleID, postID, accountID string) (circles.UploadTarget, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return circles.UploadTarget{}, err
	}
	return s.Bucket.UploadTarget(ctx, PostKey(circleID, postID))
}

// CoverUploadTarget is an admin's, matching the change that follows it:
// only an admin can point the circle at a new cover, so only an admin
// may put one in the bucket.
func (s *Service) CoverUploadTarget(ctx context.Context, circleID, coverID, accountID string) (circles.UploadTarget, error) {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return circles.UploadTarget{}, err
	}
	return s.Bucket.UploadTarget(ctx, CoverKey(circleID, coverID))
}

// DownloadURL refuses a deleted post. Invalidating the edge cache is
// best-effort and the bytes may already be gone, so this check is what
// actually stops a deleted photo being fetched.
func (s *Service) DownloadURL(ctx context.Context, circleID, postID, accountID string) (string, error) {
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
	return s.Bucket.DownloadURL(ctx, PostKey(circleID, postID))
}

// CoverDownloadURL has no row to check: a cover id is minted fresh for
// every change, so the id a member holds either exists or does not.
func (s *Service) CoverDownloadURL(ctx context.Context, circleID, coverID, accountID string) (string, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return "", err
	}
	return s.Bucket.DownloadURL(ctx, CoverKey(circleID, coverID))
}

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
