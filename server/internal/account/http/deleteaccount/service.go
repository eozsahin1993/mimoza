// Package deleteaccount is the vertical slice for DELETE /account — the
// final relay call an account ever makes. Revokes the Sign in with Apple
// grant behind the account if there is one, and revokes every session for
// the account, not just the one making this call — another signed-in
// device must not be able to outlive the account it belonged to.
package deleteaccount

import (
	"context"
	"log/slog"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/auth/appleid"
)

type Service struct {
	AuthStore auth.Store
	// Accounts holds the profile, devices and provider rows deletion
	// removes, and the Apple grant it revokes on the way.
	Accounts accounts.Store
	// RevokeApple is nil unless this environment has a Sign in with Apple
	// key configured — see appleid.NewClient. Deletion works either way.
	RevokeApple func(ctx context.Context, refreshToken string) error
}

// Delete revokes Apple first, since it needs the provider row the rest
// of this then removes, and drops every session last: a signed-in device
// must not outlive the account it belonged to.
func (s *Service) Delete(ctx context.Context, accountID string) error {
	s.revokeAppleGrant(ctx, accountID)
	if s.Accounts != nil {
		if err := s.Accounts.Delete(ctx, accountID); err != nil {
			return err
		}
	}
	return s.AuthStore.DeleteAllSessions(ctx, accountID)
}

// revokeAppleGrant spends the refresh token banked at sign-in, so the app
// stops appearing under Settings › Apple Account › Sign in with Apple
// once the account behind it is gone (App Store Review Guideline
// 5.1.1(v)).
//
// Failures are logged, never returned: someone asking to delete their
// account gets that, even when Apple is unreachable. The credential row
// is only dropped once a revoke actually succeeds — left behind, it's the
// one trace of the account worth keeping, since it's all a retry would
// have to work from.
func (s *Service) revokeAppleGrant(ctx context.Context, accountID string) {
	if s.Accounts == nil || s.RevokeApple == nil {
		return
	}

	refreshToken, err := s.appleRefreshToken(ctx, accountID)
	if err != nil {
		slog.ErrorContext(ctx, "could not read the Apple refresh token while deleting an account",
			"reason", "apple_refresh_token_unreadable", "error", err)
		return
	}
	if refreshToken == "" {
		// Nothing banked: an account from before this shipped, or one
		// whose exchange failed at sign-in. Logged because the difference
		// between "no grant to revoke" and "silently not revoking" is
		// exactly what review would catch and this log wouldn't.
		slog.WarnContext(ctx, "deleted an Apple account with no grant to revoke",
			"reason", "apple_grant_not_banked")
		return
	}

	if err := s.RevokeApple(ctx, refreshToken); err != nil {
		slog.ErrorContext(ctx, "could not revoke the Sign in with Apple grant while deleting an account",
			"reason", appleid.Reason(err), "error", err)
		return
	}
	slog.InfoContext(ctx, "revoked a Sign in with Apple grant", "reason", "apple_grant_revoked")

	// The spent token goes with the account itself, a moment later.
}

// appleRefreshToken is the grant banked at sign-in, if this account has
// an Apple sign-in at all. An account with only Google has none, which
// is ordinary rather than an error.
func (s *Service) appleRefreshToken(ctx context.Context, accountID string) (string, error) {
	providers, err := s.Accounts.Providers(ctx, accountID)
	if err != nil {
		return "", err
	}
	for _, provider := range providers {
		if provider.Name == auth.AppleProvider {
			return provider.RefreshToken, nil
		}
	}
	return "", nil
}
