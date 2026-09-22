package testsupport

import (
	"net/http"
	"testing"
	"time"

	"mimoza-relay/internal/api"
	"mimoza-relay/internal/auth/oidcverify"
)

// testRateLimitMaxRequests is deliberately huge — end-to-end router tests
// exercise real request flows, not the rate limiter itself (that's
// ratelimit/dynamodb's own tests), so it should never trip here.
const testRateLimitMaxRequests = 1_000_000

// NewRouterWithAuth builds the full api.NewRouter against real
// LocalStack-backed adapters, plus fake (but real-HTTP, real-JWT)
// Google/Apple OIDC providers — for tests that need to mint valid ID
// tokens themselves (router_auth_test.go). Tests that don't touch auth
// endpoints should use NewRouter instead.
func NewRouterWithAuth(t testing.TB) (mux *http.ServeMux, google, apple *FakeOIDCProvider) {
	t.Helper()
	google = NewFakeOIDCProvider(t, "https://accounts.google.com")
	apple = NewFakeOIDCProvider(t, "https://appleid.apple.com")
	mux = api.NewRouter(api.Deps{
		Accounts:   NewAccountTable(t),
		Circles:    NewCircleTable(t),
		Log:        NewLogStore(t),
		Blob:       NewBlobStore(t),
		Auth:       NewAuthStore(t),
		Invite:     NewInviteStore(t, 0),
		WriteLimit: NewRateLimitStore(t, "write", testRateLimitMaxRequests, time.Hour),
		ReadLimit:  NewRateLimitStore(t, "read", testRateLimitMaxRequests, time.Hour),
		Google:     oidcverify.New(google.Issuer, google.JWKSURL, []string{TestGoogleClientID}),
		Apple:      oidcverify.New(apple.Issuer, apple.JWKSURL, []string{TestAppleClientID}),
		Push: api.PushDeps{
			Store:          NewPushStore(t),
			RecipientLimit: NewRateLimitStore(t, "push", testRateLimitMaxRequests, time.Hour),
		},
	})
	return mux, google, apple
}

// NewRouter is NewRouterWithAuth without the provider handles — the one
// router construction path every end-to-end test in package api_test
// should use, so a change to api.Deps means updating this one place.
//
// Builds its own api.Deps rather than going through internal/app: these
// stores are LocalStack-backed with per-test table names, not the real
// wiring app.Deps assembles — see the integration suite for that.
func NewRouter(t testing.TB) *http.ServeMux {
	t.Helper()
	mux, _, _ := NewRouterWithAuth(t)
	return mux
}
