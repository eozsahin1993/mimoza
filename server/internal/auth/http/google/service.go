// Package google is the vertical slice for POST /v1/auth/google: verifies
// the client's Google ID token against Google's own signing keys and issues
// this relay's own bearer token for the verified subject.
package google

import (
	"context"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/auth/oidcverify"
)

type Service struct {
	AuthStore auth.Store
	Verifier  *oidcverify.Verifier
	// Accounts resolves a verified sign-in to the relay's own account id,
	// minting one the first time. The provider's subject is a lookup onto
	// that id, not the id itself, so another sign-in method can be linked
	// to the same account later without every circle it belongs to
	// noticing.
	Accounts accounts.Store
}

// providerName names this sign-in method in the lookup that resolves it
// to an account, so Google's and Apple's subjects — independently issued
// by unrelated id spaces — can never collide. Identity is keyed on sub,
// not email: sub is stable and present on every token, while email can be
// withheld, relayed through Apple's private-relay address, or changed.
const providerName = "google"

// SignIn verifies idToken against Google's own signing keys, then issues a
// bearer token for the token's verified subject — same downstream session
// machinery the apple package uses, just a different provider verifying
// the token up front.
func (s *Service) SignIn(ctx context.Context, idToken string) (string, error) {
	claims, err := s.Verifier.VerifyAndGetClaims(idToken)
	if err != nil {
		return "", err
	}

	accountID, _, err := s.Accounts.Resolve(ctx, accounts.Provider{Name: providerName, Subject: claims.Sub})
	if err != nil {
		return "", err
	}
	return auth.Issue(ctx, s.AuthStore, accountID)
}
