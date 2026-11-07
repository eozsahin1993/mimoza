// Package devsession signs in as any subject without a provider token: the
// dummy accounts a dev build offers, and the integration suite's accounts.
// It is a bypass rather than a fake issuer because a fake OIDC provider
// would have the integration suite testing the fake's JWKS round-trip
// rather than the relay. Real provider verification is covered by
// internal/app's own tests against testsupport.FakeOIDCProvider.
package devsession

import (
	"context"
	"time"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
)

// providerName keeps these subjects in their own id space, so a dummy
// "alice" can never resolve to someone's Google or Apple account.
const providerName = "testonly"

type accountStore interface {
	Resolve(ctx context.Context, provider accounts.Provider) (accountID string, created bool, err error)
}

type Service struct {
	AuthStore auth.Store
	Accounts  accountStore
	// TTL applies to a caller-chosen token only, and zero means auth.TTL,
	// the lifetime a minted one always gets.
	TTL time.Duration
}

// SignIn resolves subject to an account the same way a real sign-in does.
// A caller that already holds a token (the integration harness picks its
// own) gets that one saved; otherwise one is minted.
func (s *Service) SignIn(ctx context.Context, subject, token string) (accountID, issued string, err error) {
	accountID, _, err = s.Accounts.Resolve(ctx, accounts.Provider{Name: providerName, Subject: subject})
	if err != nil {
		return "", "", err
	}
	if token == "" {
		issued, err = auth.Issue(ctx, s.AuthStore, accountID)
		return accountID, issued, err
	}
	ttl := s.TTL
	if ttl == 0 {
		ttl = auth.TTL
	}
	err = s.AuthStore.SaveSession(ctx, token, auth.Session{AccountID: accountID, ExpiresAt: time.Now().Add(ttl)})
	return accountID, token, err
}
