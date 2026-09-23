package testsupport

import (
	"net/http"
	"testing"
	"time"

	"mimoza-relay/internal/app"
	"mimoza-relay/internal/auth/oidcverify"
)

// testRateLimitMaxRequests is deliberately huge — end-to-end router tests
// exercise real request flows, not the rate limiter itself (that's
// ratelimit/dynamodb's own tests), so it should never trip here.
const testRateLimitMaxRequests = 1_000_000

// NewRouterWithAuth builds the full app.NewRouter against real
// LocalStack-backed adapters, plus fake (but real-HTTP, real-JWT)
// Google/Apple OIDC providers — for tests that need to mint valid ID
// tokens themselves (router_auth_test.go). Tests that don't touch auth
// endpoints should use NewRouter instead.
func NewRouterWithAuth(t testing.TB) (mux *http.ServeMux, google, apple *FakeOIDCProvider) {
	t.Helper()
	google = NewFakeOIDCProvider(t, "https://accounts.google.com")
	apple = NewFakeOIDCProvider(t, "https://appleid.apple.com")
	mux = app.NewRouter(app.Deps{
		Accounts:   NewAccountTable(t),
		Circles:    NewCircleTable(t),
		Blobs:      NewBlobBucket(t),
		Auth:       NewAuthStore(t),
		WriteLimit: NewRateLimitStore(t, "write", testRateLimitMaxRequests, time.Hour),
		ReadLimit:  NewRateLimitStore(t, "read", testRateLimitMaxRequests, time.Hour),
		Google:     oidcverify.New(google.Issuer, google.JWKSURL, []string{TestGoogleClientID}),
		Apple:      oidcverify.New(apple.Issuer, apple.JWKSURL, []string{TestAppleClientID}),
	})
	return mux, google, apple
}

// NewRouter is NewRouterWithAuth without the provider handles — the one
// router construction path every end-to-end test in package app_test
// should use, so a change to app.Deps means updating this one place.
//
// Builds its own app.Deps rather than going through app.AWSDeps: these
// stores are LocalStack-backed with per-test table names, not the real
// wiring AWSDeps assembles — see the integration suite for that.
func NewRouter(t testing.TB) *http.ServeMux {
	t.Helper()
	mux, _, _ := NewRouterWithAuth(t)
	return mux
}
