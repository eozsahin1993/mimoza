package appleid

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func testKey(t *testing.T) Key {
	t.Helper()
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalECPrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return Key{
		KeyID:      "TESTKEYID1",
		TeamID:     "TESTTEAMID",
		ClientID:   "com.rarekiwisoftware.mimoza",
		PrivateKey: string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})),
	}
}

// fakeApple stands in for Apple's token host, recording the one form it
// was posted so a test can assert on what the relay actually sent.
func fakeApple(t *testing.T, path string, status int, body string) (*Client, *url.Values) {
	t.Helper()
	key := testKey(t)
	var got url.Values

	mux := http.NewServeMux()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		got = r.PostForm
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	return &Client{
		LoadKey: func(context.Context) (Key, error) { return key, nil },
		BaseURL: server.URL,
	}, &got
}

func TestExchangeCodeReturnsTheRefreshToken(t *testing.T) {
	client, form := fakeApple(t, "/auth/token", http.StatusOK, `{"refresh_token":"r-123","access_token":"a-1"}`)

	refreshToken, err := client.ExchangeCode(context.Background(), "code-abc")
	if err != nil {
		t.Fatal(err)
	}
	if refreshToken != "r-123" {
		t.Fatalf("expected the refresh token from Apple, got %q", refreshToken)
	}
	if form.Get("grant_type") != "authorization_code" {
		t.Errorf("expected an authorization_code grant, got %q", form.Get("grant_type"))
	}
	if form.Get("code") != "code-abc" {
		t.Errorf("expected the client's code to be forwarded, got %q", form.Get("code"))
	}
}

// Apple answers an expired or already-spent code with a 400 and an error
// code; that must surface rather than read as a successful exchange.
func TestExchangeCodeFailsOnApplesError(t *testing.T) {
	client, _ := fakeApple(t, "/auth/token", http.StatusBadRequest, `{"error":"invalid_grant"}`)

	if _, err := client.ExchangeCode(context.Background(), "stale"); err == nil {
		t.Fatal("expected an error for a rejected code")
	}
}

// The refresh token is what Guideline 5.1.1(v) wants revoked — an
// access_token hint would leave the grant itself standing.
func TestRevokeSendsTheRefreshToken(t *testing.T) {
	client, form := fakeApple(t, "/auth/revoke", http.StatusOK, "")

	if err := client.Revoke(context.Background(), "r-123"); err != nil {
		t.Fatal(err)
	}
	if form.Get("token") != "r-123" {
		t.Errorf("expected the stored refresh token, got %q", form.Get("token"))
	}
	if form.Get("token_type_hint") != "refresh_token" {
		t.Errorf("expected a refresh_token hint, got %q", form.Get("token_type_hint"))
	}
}

func TestRevokeFailsOnApplesError(t *testing.T) {
	client, _ := fakeApple(t, "/auth/revoke", http.StatusBadRequest, `{"error":"invalid_client"}`)

	if err := client.Revoke(context.Background(), "r-123"); err == nil {
		t.Fatal("expected an error when Apple rejects the revoke")
	}
}

// Apple rejects a client secret whose claims are shaped wrong, and its
// only signal is "invalid_client" — cheaper to assert the shape here than
// to debug it against the real endpoint.
func TestClientSecretCarriesTheClaimsAppleRequires(t *testing.T) {
	key := testKey(t)

	secret, err := clientSecret(key)
	if err != nil {
		t.Fatal(err)
	}

	parsed, _, err := jwt.NewParser().ParseUnverified(secret, jwt.MapClaims{})
	if err != nil {
		t.Fatal(err)
	}
	claims := parsed.Claims.(jwt.MapClaims)

	if parsed.Header["kid"] != key.KeyID {
		t.Errorf("expected the key id in the header, got %v", parsed.Header["kid"])
	}
	if parsed.Method.Alg() != "ES256" {
		t.Errorf("expected ES256, got %s", parsed.Method.Alg())
	}
	if claims["iss"] != key.TeamID {
		t.Errorf("expected the team id as issuer, got %v", claims["iss"])
	}
	if claims["sub"] != key.ClientID {
		t.Errorf("expected the client id as subject, got %v", claims["sub"])
	}
	if claims["aud"] != DefaultBaseURL {
		t.Errorf("expected Apple as audience, got %v", claims["aud"])
	}
}

// The reasons exist to be filtered on in CloudWatch, so what matters is
// that the three cases stay distinguishable — a broken key needs a
// person, a rejected code doesn't.
func TestReasonTellsTheActionableFailuresApart(t *testing.T) {
	rejecting, _ := fakeApple(t, "/auth/revoke", http.StatusBadRequest, `{"error":"invalid_client"}`)
	err := rejecting.Revoke(context.Background(), "r-123")
	if got := Reason(err); got != "apple_rejected" {
		t.Errorf("expected apple_rejected, got %q", got)
	}

	unloadable := &Client{
		LoadKey: func(context.Context) (Key, error) { return Key{}, errors.New("ssm is unhappy") },
	}
	if got := Reason(unloadable.Revoke(context.Background(), "r-123")); got != "apple_key_unavailable" {
		t.Errorf("expected apple_key_unavailable, got %q", got)
	}

	// A key that loads but is missing an identifier is the same class of
	// problem — a misconfigured environment, not a bad request.
	incomplete := &Client{
		LoadKey: func(context.Context) (Key, error) { return Key{PrivateKey: "not-a-key"}, nil },
	}
	if got := Reason(incomplete.Revoke(context.Background(), "r-123")); got != "apple_key_unavailable" {
		t.Errorf("expected apple_key_unavailable, got %q", got)
	}

	unreachable := &Client{
		LoadKey: func(context.Context) (Key, error) { return testKey(t), nil },
		// A port nothing listens on, so Do fails at the transport.
		BaseURL: "http://127.0.0.1:1",
	}
	if got := Reason(unreachable.Revoke(context.Background(), "r-123")); got != "apple_unreachable" {
		t.Errorf("expected apple_unreachable, got %q", got)
	}

	if got := Reason(nil); got != "" {
		t.Errorf("expected no reason for no error, got %q", got)
	}
}

func TestClientSecretNeedsEveryIdentifier(t *testing.T) {
	key := testKey(t)
	key.TeamID = ""

	if _, err := clientSecret(key); err == nil {
		t.Fatal("expected an error when the team id is missing")
	}
}
