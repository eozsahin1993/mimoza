package profile

import (
	"context"
	"log/slog"

	"mimoza-relay/internal/accounts/avatar"

	"mimoza-relay/internal/accounts"
)

type store interface {
	GetProfile(ctx context.Context, accountID string) (accounts.Profile, error)
	SetProfile(ctx context.Context, accountID, name, avatarID string) error
	SetPublicKey(ctx context.Context, accountID string, publicKey []byte) error
}

// rewrapper is the circles column's side of replacing a keypair: every
// membership this account holds is flagged, so the next member to sync
// reseals the content keys to the new key.
type rewrapper interface {
	MarkMembershipsNeedRewrap(ctx context.Context, accountID string) ([]string, error)
}

// bucket is here for one reason: a replaced picture has nothing left
// pointing at it.
type bucket interface {
	Delete(ctx context.Context, key string) error
}

type Service struct {
	Store store
	// Circles is what turns a new public key into a repair. Without it a
	// replaced key would leave every circle unreadable with nothing
	// asking anyone to fix it.
	Circles rewrapper
	// Nil leaves replaced pictures in the bucket, which costs storage
	// and nothing else.
	Blobs bucket
}

func (s *Service) Get(ctx context.Context, accountID string) (accounts.Profile, error) {
	return s.Store.GetProfile(ctx, accountID)
}

// Set writes the name and the avatar together: they are one act on a
// screen.
func (s *Service) Set(ctx context.Context, accountID, name, avatarID string) (accounts.Profile, error) {
	previous, err := s.Store.GetProfile(ctx, accountID)
	if err != nil {
		return accounts.Profile{}, err
	}
	if err := s.Store.SetProfile(ctx, accountID, name, avatarID); err != nil {
		return accounts.Profile{}, err
	}
	s.retire(ctx, accountID, previous.AvatarID, avatarID)
	return s.Store.GetProfile(ctx, accountID)
}

// retire runs after the write, so a failure leaves bytes nothing points
// at rather than a profile pointing at bytes that are gone.
func (s *Service) retire(ctx context.Context, accountID, previous, current string) {
	if s.Blobs == nil || previous == "" || previous == current {
		return
	}
	if err := s.Blobs.Delete(ctx, avatar.Key(accountID, previous)); err != nil {
		slog.ErrorContext(ctx, "replaced an avatar but did not delete the old one",
			"reason", "avatar_not_deleted", "error", err, "avatarId", previous)
	}
}

// SetPublicKey publishes the key members seal to. reset says this device
// has no private key and made a new pair, which makes every sealed copy
// unreadable: the memberships are flagged so another member reseals
// them. Returns the circles now waiting on that.
func (s *Service) SetPublicKey(ctx context.Context, accountID string, publicKey []byte, reset bool) ([]string, error) {
	if err := s.Store.SetPublicKey(ctx, accountID, publicKey); err != nil {
		return nil, err
	}
	if !reset || s.Circles == nil {
		return nil, nil
	}
	return s.Circles.MarkMembershipsNeedRewrap(ctx, accountID)
}
