// End-to-end tests for the Google/Apple sign-in and logout routes, against
// the fully assembled router — see router_test.go's top comment for why
// this is separate from the per-package unit tests.
package app_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"mimoza-relay/internal/util/testsupport"
)

func validClaims(t *testing.T, email, audience string) jwt.MapClaims {
	return jwt.MapClaims{
		"aud":            audience,
		"sub":            testsupport.UniqueAccountID(t),
		"email":          email,
		"email_verified": true,
		"exp":            time.Now().Add(time.Hour).Unix(),
		"iat":            time.Now().Unix(),
	}
}

func postSignIn(t *testing.T, serverURL, path, idToken string) *http.Response {
	t.Helper()
	resp, err := http.Post(serverURL+path, "application/json", strings.NewReader(`{"idToken":"`+idToken+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// postAppleSignIn is postSignIn plus the authorization code /auth/apple
// requires. The code goes unspent here: these routers have no Sign in
// with Apple key wired, so nothing tries to exchange it at Apple.
func postAppleSignIn(t *testing.T, serverURL, idToken string) *http.Response {
	t.Helper()
	body := `{"idToken":"` + idToken + `","authorizationCode":"test-authorization-code"}`
	resp, err := http.Post(serverURL+"/v1/auth/apple", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func decodeToken(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Token
}

func TestEndToEnd_GoogleSignIn(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	email := testsupport.UniqueEmail(t)
	claims := validClaims(t, email, testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	idToken := google.SignToken(t, claims)

	resp := postSignIn(t, server.URL, "/v1/auth/google", idToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if token := decodeToken(t, resp); token == "" {
		t.Fatal("expected a non-empty token")
	}
}

func TestEndToEnd_AppleSignIn(t *testing.T) {
	mux, _, apple := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	email := testsupport.UniqueEmail(t)
	claims := validClaims(t, email, testsupport.TestAppleClientID)
	claims["iss"] = apple.Issuer
	// Apple's real tokens send email_verified as a string, not a bool —
	// exercising that here, not just in oidcverify's own unit tests, to
	// prove the router's actual Apple wiring accepts it too.
	claims["email_verified"] = "true"
	idToken := apple.SignToken(t, claims)

	resp := postAppleSignIn(t, server.URL, idToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if token := decodeToken(t, resp); token == "" {
		t.Fatal("expected a non-empty token")
	}
}

// Apple can omit the email claim on a given authorization (a documented
// quirk, not malformed input) — sign-in keys on sub alone, so this must
// still succeed against the real router wiring, not just oidcverify's own
// unit tests.
func TestEndToEnd_AppleSignIn_MissingEmailStillSucceeds(t *testing.T) {
	mux, _, apple := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := jwt.MapClaims{
		"iss": apple.Issuer,
		"aud": testsupport.TestAppleClientID,
		"sub": testsupport.UniqueAccountID(t),
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
	idToken := apple.SignToken(t, claims)

	resp := postAppleSignIn(t, server.URL, idToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if token := decodeToken(t, resp); token == "" {
		t.Fatal("expected a non-empty token")
	}
}

func TestEndToEnd_GoogleSignIn_WrongIssuerReturns401(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = "https://not-actually-google.example"
	// Signed by the fake Google key but claiming a different issuer —
	// the router's Google verifier is configured to only accept
	// "https://accounts.google.com", so this must still be rejected.
	idToken := google.SignToken(t, claims)

	resp := postSignIn(t, server.URL, "/v1/auth/google", idToken)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_GoogleSignIn_TokenSignedByAppleKeyIsRejected(t *testing.T) {
	mux, _, apple := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = "https://accounts.google.com"
	// Signed by Apple's fake key, not Google's — must fail signature
	// verification against Google's JWKS regardless of what the claims say.
	idToken := apple.SignToken(t, claims)

	resp := postSignIn(t, server.URL, "/v1/auth/google", idToken)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_SignInWithMissingIDTokenReturns400(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Post(server.URL+"/v1/auth/google", "application/json", strings.NewReader(`{"idToken":""}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

// Without the code there's nothing to revoke at deletion, which
// Guideline 5.1.1(v) requires — so /auth/apple refuses the sign-in
// outright rather than creating an account it can't fully delete.
func TestEndToEnd_AppleSignInWithoutAnAuthorizationCodeReturns400(t *testing.T) {
	mux, _, apple := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestAppleClientID)
	claims["iss"] = apple.Issuer
	idToken := apple.SignToken(t, claims)

	resp, err := http.Post(server.URL+"/v1/auth/apple", "application/json", strings.NewReader(`{"idToken":"`+idToken+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_LogoutRevokesTheSession(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	idToken := google.SignToken(t, claims)
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", idToken))

	req, err := http.NewRequest(http.MethodPost, server.URL+"/v1/auth/logout", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from logout, got %d", resp.StatusCode)
	}
	var body struct {
		OK bool `json:"ok"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK {
		t.Fatal("expected ok:true from logout")
	}
}

func TestEndToEnd_LogoutWithoutBearerTokenReturns400(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Post(server.URL+"/v1/auth/logout", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}
