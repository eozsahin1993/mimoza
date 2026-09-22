// Package deleteaccount is the vertical slice for DELETE /account — the
// final relay call an account ever makes. Revokes the Sign in with Apple
// grant behind the account if there is one, and revokes every session for
// the account, not just the one making this call — another signed-in
// device must not be able to outlive the account it belonged to.
package deleteaccount

import (
	"context"
	"log/slog"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/auth/appleid"
)

type Service struct {
	AuthStore auth.Store
	// AppleCredentials and RevokeApple are both nil unless this
	// environment has a Sign in with Apple key configured — see
	// appleid.NewClient. Deletion works either way.
	AppleCredentials auth.AppleCredentialStore
	RevokeApple      func(ctx context.Context, refreshToken string) error
}

// Delete revokes Apple first, since it needs the credential row that the
// rest of this then removes, and drops every session last.
func (s *Service) Delete(ctx context.Context, accountID string) error {
	s.revokeAppleGrant(ctx, accountID)
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
	if s.AppleCredentials == nil || s.RevokeApple == nil || !auth.IsAppleAccount(accountID) {
		return
	}

	refreshToken, err := s.AppleCredentials.GetAppleRefreshToken(ctx, accountID)
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

	if err := s.AppleCredentials.DeleteAppleRefreshToken(ctx, accountID); err != nil {
		slog.ErrorContext(ctx, "could not delete the spent Apple refresh token",
			"reason", "apple_refresh_token_not_deleted", "error", err)
	}
}
