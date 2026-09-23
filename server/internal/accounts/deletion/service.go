package deletion

import (
	"context"
	"log/slog"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/auth/appleid"
	"mimoza-relay/internal/circles/erase"
)

type store interface {
	// Providers is read before the account goes: the Apple grant to
	// revoke is on one of these rows.
	Providers(ctx context.Context, accountID string) ([]accounts.Provider, error)
	// GetProfile is read for the name each circle stamps on its
	// account_deleted row.
	GetProfile(ctx context.Context, accountID string) (accounts.Profile, error)
	Delete(ctx context.Context, accountID, keep string) error
}

// circles is the other column's half: building circle rows is its
// business, not this one's.
type circles interface {
	Account(ctx context.Context, accountID, name string) (erase.Erased, error)
}

// bucket is what is deleted once the rows are gone.
type blobs interface {
	Delete(ctx context.Context, key string) error
	DeletePrefix(ctx context.Context, prefix string) error
}

type Service struct {
	AuthStore auth.Store
	// Store holds the profile, devices and provider rows deletion
	// removes, and the Apple grant it revokes on the way.
	Store store
	// Circles and Blobs are nil in tests that only care about the
	// account's own rows.
	Circles circles
	Blobs   blobs
	// RevokeApple is nil unless this environment has a Sign in with Apple
	// key configured — see appleid.NewClient. Deletion works either way.
	RevokeApple func(ctx context.Context, refreshToken string) error
}

// Delete revokes Apple first, since it needs the provider row the rest
// of this then removes, and drops every session last: a signed-in device
// must not outlive the account it belonged to. An unspent grant is the
// one row that stays, so the revoke can be retried.
func (s *Service) Delete(ctx context.Context, accountID string) error {
	keep := s.revokeAppleGrant(ctx, accountID)

	// Circles first, while the profile still has a name to stamp.
	if err := s.eraseCircles(ctx, accountID); err != nil {
		return err
	}
	if err := s.Store.Delete(ctx, accountID, keep); err != nil {
		return err
	}
	return s.AuthStore.DeleteAllSessions(ctx, accountID)
}

// eraseCircles empties the circles, then the bucket. A failed blob
// delete is logged, not returned: the rows are gone, so the bytes are
// unreachable and a retry would not find them either.
func (s *Service) eraseCircles(ctx context.Context, accountID string) error {
	if s.Circles == nil {
		return nil
	}

	name := ""
	if profile, err := s.Store.GetProfile(ctx, accountID); err == nil {
		name = profile.Name
	}

	erased, err := s.Circles.Account(ctx, accountID, name)
	if err != nil {
		return err
	}
	if s.Blobs == nil {
		return nil
	}
	for _, key := range erased.BlobKeys {
		if err := s.Blobs.Delete(ctx, key); err != nil {
			slog.ErrorContext(ctx, "deleted an account but not one of its photos",
				"reason", "blob_not_deleted", "error", err, "key", key)
		}
	}
	for _, prefix := range erased.Prefixes {
		if err := s.Blobs.DeletePrefix(ctx, prefix); err != nil {
			slog.ErrorContext(ctx, "deleted a circle but not its photos",
				"reason", "blobs_not_deleted", "error", err, "prefix", prefix)
		}
	}
	return nil
}

// revokeAppleGrant spends the refresh token banked at sign-in, so the app
// stops appearing under Settings › Apple Account › Sign in with Apple
// once the account behind it is gone (App Store Review Guideline
// 5.1.1(v)).
//
// Failures are logged, never returned — an outage at Apple must not block
// someone deleting their account. It returns the sort key of an unspent
// grant, which deletion then leaves behind: it is all a later retry would
// have to work from.
func (s *Service) revokeAppleGrant(ctx context.Context, accountID string) string {
	if s.RevokeApple == nil {
		return ""
	}

	apple, err := s.appleProvider(ctx, accountID)
	if err != nil {
		slog.ErrorContext(ctx, "could not read the Apple refresh token while deleting an account",
			"reason", "apple_refresh_token_unreadable", "error", err)
		return ""
	}
	if apple == nil {
		return ""
	}
	if apple.RefreshToken == "" {
		// An account from before this shipped, or one whose exchange
		// failed at sign-in. Nothing to keep, and nothing a retry could do.
		slog.WarnContext(ctx, "deleted an Apple account with no grant to revoke",
			"reason", "apple_grant_not_banked")
		return ""
	}

	if err := s.RevokeApple(ctx, apple.RefreshToken); err != nil {
		slog.ErrorContext(ctx, "could not revoke the Sign in with Apple grant while deleting an account",
			"reason", appleid.Reason(err), "error", err)
		return dynamo.ProviderKey(apple.Name, apple.Subject)
	}
	slog.InfoContext(ctx, "revoked a Sign in with Apple grant", "reason", "apple_grant_revoked")
	return ""
}

// appleProvider is this account's Apple sign-in, nil if it has none.
func (s *Service) appleProvider(ctx context.Context, accountID string) (*accounts.Provider, error) {
	providers, err := s.Store.Providers(ctx, accountID)
	if err != nil {
		return nil, err
	}
	for _, provider := range providers {
		if provider.Name == auth.AppleProvider {
			return &provider, nil
		}
	}
	return nil, nil
}
