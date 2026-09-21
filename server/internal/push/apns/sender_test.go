package apns

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mimoza-relay/internal/push"
)

// A real key, generated per run — the JWT path is genuinely exercised
// rather than stubbed.
func testKey(t *testing.T) *AuthKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	return &AuthKey{KeyID: "kid-1", TeamID: "team-1", PrivateKey: string(encoded)}
}

func TestHostSelection(t *testing.T) {
	if (&Sender{Production: false}).host() != sandboxHost {
		t.Fatal("expected the sandbox host by default")
	}
	if (&Sender{Production: true}).host() != productionHost {
		t.Fatal("expected the production host when configured")
	}
}

func TestSendPostsAnAlertWithMutableContent(t *testing.T) {
	var got map[string]any
	var headers http.Header
	apnsAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = r.Header.Clone()
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusOK)
	}))
	defer apnsAPI.Close()

	sender := New(testKey(t), "com.eozsahin.mimoza", false)
	sender.Client.Transport = redirectTo(apnsAPI.URL)

	if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("ciphertext")); err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(headers.Get("Authorization"), "bearer ") {
		t.Fatalf("expected a bearer provider token, got %q", headers.Get("Authorization"))
	}
	if headers.Get("Apns-Topic") != "com.eozsahin.mimoza" {
		t.Fatalf("wrong topic: %q", headers.Get("Apns-Topic"))
	}
	if headers.Get("Apns-Push-Type") != "alert" {
		t.Fatalf("expected an alert push, got %q", headers.Get("Apns-Push-Type"))
	}

	aps, ok := got["aps"].(map[string]any)
	if !ok {
		t.Fatalf("missing aps dictionary: %v", got)
	}
	if aps["alert"] != push.Placeholder {
		t.Fatalf("expected the fixed placeholder, got %v", aps["alert"])
	}
	if aps["mutable-content"].(float64) != 1 {
		t.Fatal("expected mutable-content so the extension can rewrite the alert")
	}
	if got["payload"] != base64.StdEncoding.EncodeToString([]byte("ciphertext")) {
		t.Fatalf("payload did not survive: %v", got["payload"])
	}
	if got["pushRoutingId"] != "routing-1" {
		t.Fatalf("the device needs the routing id to find its circle, got %v", got["pushRoutingId"])
	}
}

func TestProviderTokenIsReusedAcrossSends(t *testing.T) {
	var authHeaders []string
	apnsAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer apnsAPI.Close()

	sender := New(testKey(t), "com.eozsahin.mimoza", false)
	sender.Client.Transport = redirectTo(apnsAPI.URL)

	for range 2 {
		if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}

	if authHeaders[0] != authHeaders[1] {
		t.Fatal("expected the same provider token reused within its lifetime")
	}
}

// ECDSA signing is randomized, so a re-minted token never matches the one
// it replaced — that's what this asserts, rather than counting signs.
func TestAnExpiredProviderTokenIsReminted(t *testing.T) {
	var authHeaders []string
	apnsAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer apnsAPI.Close()

	sender := New(testKey(t), "com.eozsahin.mimoza", false)
	sender.Client.Transport = redirectTo(apnsAPI.URL)

	if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x")); err != nil {
		t.Fatal(err)
	}
	sender.tokens.expiresAt = time.Now().Add(-time.Hour)
	if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x")); err != nil {
		t.Fatal(err)
	}

	if authHeaders[0] == authHeaders[1] {
		t.Fatal("expected a fresh token after expiry, got the same one")
	}
}

func TestSendReportsAFailedStatus(t *testing.T) {
	apnsAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"reason":"BadDeviceToken"}`, http.StatusGone)
	}))
	defer apnsAPI.Close()

	sender := New(testKey(t), "com.eozsahin.mimoza", false)
	sender.Client.Transport = redirectTo(apnsAPI.URL)

	err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x"))
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "device-token") {
		t.Fatalf("the error carried the device token: %v", err)
	}
}

func TestAMalformedKeyDoesNotLeakItself(t *testing.T) {
	key := &AuthKey{
		KeyID:      "kid-1",
		TeamID:     "team-1",
		PrivateKey: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
	}

	err := New(key, "com.eozsahin.mimoza", false).Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x"))
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "not-a-key") {
		t.Fatalf("the error quoted the key: %v", err)
	}
}

// redirectTo points every request at a test server, so Send can keep
// building the real api(.sandbox).push.apple.com URL.
func redirectTo(target string) http.RoundTripper {
	return roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.Host, "apple.com") {
			replacement, _ := http.NewRequest(req.Method, target, req.Body)
			replacement.Header = req.Header
			return http.DefaultTransport.RoundTrip(replacement)
		}
		return http.DefaultTransport.RoundTrip(req)
	})
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

// An invite address's line shows when the device can't write its own; the
// kind rides along so it can pick its own.
func TestSendAttachesTheKindsLine(t *testing.T) {
	var got map[string]any
	apnsAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusOK)
	}))
	defer apnsAPI.Close()

	sender := New(testKey(t), "com.eozsahin.mimoza", false)
	sender.Client.Transport = redirectTo(apnsAPI.URL)

	if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindInvite, 0, []byte("x")); err != nil {
		t.Fatal(err)
	}

	if got["aps"].(map[string]any)["alert"] != push.KindInvite.Alert() {
		t.Fatalf("expected the invite line, got %v", got["aps"])
	}
	if got["kind"] != string(push.KindInvite) {
		t.Fatalf("expected the kind, got %v", got["kind"])
	}
}
