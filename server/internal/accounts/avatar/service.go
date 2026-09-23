package avatar

import (
	"context"
	"strings"

	"mimoza-relay/internal/blobs"
)

// bucket is the blob storage. An avatar needs no row: the profile holds
// which key is current.
type bucket interface {
	UploadTarget(ctx context.Context, key string, maxBytes int64) (blobs.UploadTarget, error)
	DownloadURL(ctx context.Context, key string) (string, error)
}

// Key carries the client's content hash, so a changed picture is a
// changed URL and the edge may cache forever. Keys travel whole rather
// than being rebuilt from an account id: knowing who someone is must not
// tell you where their picture is.
func Key(accountID, avatarID string) string {
	return Prefix(accountID) + avatarID
}

// Prefix is everything one account's pictures live under.
func Prefix(accountID string) string { return "avatars/" + accountID + "/" }

// Owns guards the profile write: without it an account could point at
// someone else's picture and wear their face.
func Owns(accountID, key string) bool {
	id, found := strings.CutPrefix(key, Prefix(accountID))
	return found && id != "" && !strings.Contains(id, "/")
}

// MaxSize caps one picture, far below what a photo is allowed.
const MaxSize = 512 * 1024

type Service struct {
	Bucket bucket
}

// UploadTarget is where a device sends its own picture. An unchanged
// picture hashes to a key that already holds those bytes and is refused,
// which is the answer rather than an error.
func (s *Service) UploadTarget(ctx context.Context, accountID, avatarID string) (blobs.UploadTarget, error) {
	return s.Bucket.UploadTarget(ctx, Key(accountID, avatarID), MaxSize)
}

// DownloadURL needs no membership check: the id is an unguessable hash,
// and the only way to hold one is a roster the caller could already
// read.
func (s *Service) DownloadURL(ctx context.Context, accountID, avatarID string) (string, error) {
	return s.Bucket.DownloadURL(ctx, Key(accountID, avatarID))
}
