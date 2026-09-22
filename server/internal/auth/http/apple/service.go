// Package apple is the vertical slice for POST /v1/auth/apple: verifies the
// client's Apple ID token against Apple's own signing keys and issues this
// relay's own bearer token for the verified subject.
package apple

import (
	"context"
	"log/slog"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/auth/appleid"
	"mimoza-relay/internal/auth/oidcverify"
)

type Service struct {
	AuthStore auth.Store
	Verifier  *oidcverify.Verifier
	// AppleID and Credentials are both nil unless this environment has a
	// Sign in with Apple key configured — see appleid.NewClient. Sign-in
	// works either way; without them, deleting an account can't revoke the
	// Apple grant behind it.
	AppleID *appleid.Client
	// Accounts resolves the sign-in to an account id, and holds the
	// refresh token against the provider row it came from.
	Accounts accounts.Store
}

// providerName namespaces the accountID so Google's and Apple's sub
// values, independently issued by unrelated ID spaces, can never collide.
// Identity is keyed on sub, not email: sub is guaranteed stable and
// present on every token, while email can be withheld, relayed through
// Apple's private-relay address, or changed later.
const providerName = auth.AppleProvider

// SignIn verifies idToken against Apple's own signing keys, then issues a
// bearer token for the token's verified subject — sub is present on every
// authorization regardless of Apple's first-authorization-only quirk for
// email/fullName, so this isn't affected by that.
//
// authorizationCode is no part of authenticating anyone — it's banked
// for account deletion's revoke call. See rememberGrant.
func (s *Service) SignIn(ctx context.Context, idToken, authorizationCode string) (string, error) {
	claims, err := s.Verifier.VerifyAndGetClaims(idToken)
	if err != nil {
		return "", err
	}

	accountID, _, err := s.Accounts.Resolve(ctx, accounts.Provider{Name: providerName, Subject: claims.Sub})
	if err != nil {
		return "", err
	}
	s.rememberGrant(ctx, accountID, claims.Sub, authorizationCode)
	return auth.Issue(ctx, s.AuthStore, accountID)
}

// rememberGrant exchanges the one-time authorization code for a refresh
// token and stores it, so deleting this account can revoke the Sign in
// with Apple grant later (App Store Review Guideline 5.1.1(v)). The code
// expires in minutes, which is why this happens now rather than at
// deletion.
//
// Best-effort on purpose: Apple being unreachable, or a key not yet
// configured, must not stop someone signing in. The cost of failing here
// is that deletion has nothing to revoke — logged, not raised.
func (s *Service) rememberGrant(ctx context.Context, accountID, subject, authorizationCode string) {
	if s.AppleID == nil || s.Accounts == nil {
		return
	}

	refreshToken, err := s.AppleID.ExchangeCode(ctx, authorizationCode)
	if err != nil {
		slog.WarnContext(ctx, "could not exchange the Apple authorization code",
			"reason", appleid.Reason(err), "error", err)
		return
	}
	if err := s.Accounts.SaveRefreshToken(ctx, accountID, providerName, subject, refreshToken); err != nil {
		slog.WarnContext(ctx, "could not store the Apple refresh token",
			"reason", "apple_refresh_token_not_stored", "error", err)
	}
}
