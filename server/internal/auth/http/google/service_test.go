package google_test

import (
	"context"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"mimoza-relay/internal/auth/http/google"
	"mimoza-relay/internal/auth/oidcverify"
	"mimoza-relay/internal/util/testsupport"
)

func TestService_SignIn_ValidTokenIssuesASession(t *testing.T) {
	ctx := context.Background()
	provider := testsupport.NewFakeOIDCProvider(t, "https://accounts.google.com")
	authStore := testsupport.NewAuthStore(t)
	svc := &google.Service{
		AuthStore: authStore,
		Accounts:  testsupport.NewAccountStore(t),
		Verifier:  oidcverify.New(provider.Issuer, provider.JWKSURL, []string{testsupport.TestGoogleClientID}),
	}

	idToken := provider.SignToken(t, jwt.MapClaims{
		"iss":            provider.Issuer,
		"aud":            testsupport.TestGoogleClientID,
		"sub":            testsupport.UniqueAccountID(t),
		"email":          testsupport.UniqueEmail(t),
		"email_verified": true,
		"exp":            time.Now().Add(time.Hour).Unix(),
	})

	token, err := svc.SignIn(ctx, idToken)
	if err != nil {
		t.Fatal(err)
	}
	if token == "" {
		t.Fatal("expected a non-empty token")
	}

	session, err := authStore.GetSession(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if session == nil {
		t.Fatal("expected the issued token to resolve to a session")
	}
}

func TestService_SignIn_SameSubTwiceResolvesToTheSameAccount(t *testing.T) {
	ctx := context.Background()
	provider := testsupport.NewFakeOIDCProvider(t, "https://accounts.google.com")
	authStore := testsupport.NewAuthStore(t)
	svc := &google.Service{
		AuthStore: authStore,
		Accounts:  testsupport.NewAccountStore(t),
		Verifier:  oidcverify.New(provider.Issuer, provider.JWKSURL, []string{testsupport.TestGoogleClientID}),
	}

	sub := testsupport.UniqueAccountID(t)
	claims := func() jwt.MapClaims {
		return jwt.MapClaims{
			"iss":            provider.Issuer,
			"aud":            testsupport.TestGoogleClientID,
			"sub":            sub,
			"email":          testsupport.UniqueEmail(t),
			"email_verified": true,
			"exp":            time.Now().Add(time.Hour).Unix(),
		}
	}

	token1, err := svc.SignIn(ctx, provider.SignToken(t, claims()))
	if err != nil {
		t.Fatal(err)
	}
	token2, err := svc.SignIn(ctx, provider.SignToken(t, claims()))
	if err != nil {
		t.Fatal(err)
	}
	if token1 == token2 {
		t.Fatal("expected a fresh token on each sign-in, got the same one twice")
	}

	session1, err := authStore.GetSession(ctx, token1)
	if err != nil {
		t.Fatal(err)
	}
	session2, err := authStore.GetSession(ctx, token2)
	if err != nil {
		t.Fatal(err)
	}
	if session1.AccountID != session2.AccountID {
		t.Fatalf("expected both sign-ins for the same sub to resolve to the same account, got %q and %q",
			session1.AccountID, session2.AccountID)
	}
}

func TestService_SignIn_DifferentEmailSameSubStillResolvesToTheSameAccount(t *testing.T) {
	ctx := context.Background()
	provider := testsupport.NewFakeOIDCProvider(t, "https://accounts.google.com")
	authStore := testsupport.NewAuthStore(t)
	svc := &google.Service{
		AuthStore: authStore,
		Accounts:  testsupport.NewAccountStore(t),
		Verifier:  oidcverify.New(provider.Issuer, provider.JWKSURL, []string{testsupport.TestGoogleClientID}),
	}

	sub := testsupport.UniqueAccountID(t)
	claimsWithEmail := func(email string) jwt.MapClaims {
		return jwt.MapClaims{
			"iss":            provider.Issuer,
			"aud":            testsupport.TestGoogleClientID,
			"sub":            sub,
			"email":          email,
			"email_verified": true,
			"exp":            time.Now().Add(time.Hour).Unix(),
		}
	}

	token1, err := svc.SignIn(ctx, provider.SignToken(t, claimsWithEmail(testsupport.UniqueEmail(t))))
	if err != nil {
		t.Fatal(err)
	}
	token2, err := svc.SignIn(ctx, provider.SignToken(t, claimsWithEmail(testsupport.UniqueEmail(t))))
	if err != nil {
		t.Fatal(err)
	}

	session1, err := authStore.GetSession(ctx, token1)
	if err != nil {
		t.Fatal(err)
	}
	session2, err := authStore.GetSession(ctx, token2)
	if err != nil {
		t.Fatal(err)
	}
	if session1.AccountID != session2.AccountID {
		t.Fatalf("expected a changed email on a returning sub to still resolve to the same account, got %q and %q",
			session1.AccountID, session2.AccountID)
	}
}

func TestService_SignIn_InvalidTokenIsRejected(t *testing.T) {
	ctx := context.Background()
	provider := testsupport.NewFakeOIDCProvider(t, "https://accounts.google.com")
	svc := &google.Service{
		AuthStore: testsupport.NewAuthStore(t),
		Accounts:  testsupport.NewAccountStore(t),
		Verifier:  oidcverify.New(provider.Issuer, provider.JWKSURL, []string{testsupport.TestGoogleClientID}),
	}

	if _, err := svc.SignIn(ctx, "not-a-real-token"); err == nil {
		t.Fatal("expected an error for a garbage token")
	}
}

// Apple can omit the email claim on a given authorization — sign-in keys
// on sub alone, so this must still succeed.
func TestService_SignIn_MissingEmailStillIssuesASession(t *testing.T) {
	ctx := context.Background()
	provider := testsupport.NewFakeOIDCProvider(t, "https://accounts.google.com")
	svc := &google.Service{
		AuthStore: testsupport.NewAuthStore(t),
		Accounts:  testsupport.NewAccountStore(t),
		Verifier:  oidcverify.New(provider.Issuer, provider.JWKSURL, []string{testsupport.TestGoogleClientID}),
	}

	idToken := provider.SignToken(t, jwt.MapClaims{
		"iss": provider.Issuer,
		"aud": testsupport.TestGoogleClientID,
		"sub": testsupport.UniqueAccountID(t),
		"exp": time.Now().Add(time.Hour).Unix(),
	})

	if _, err := svc.SignIn(ctx, idToken); err != nil {
		t.Fatal(err)
	}
}
