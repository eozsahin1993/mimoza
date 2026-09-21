package fcm

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
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

// A real key, generated per run — the assertion is genuinely signed, so
// the JWT path is exercised rather than stubbed.
func testAccount(t *testing.T, tokenURI string) *ServiceAccount {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return &ServiceAccount{
		ProjectID:   "circle-test",
		ClientEmail: "sender@mimoza-test.iam.gserviceaccount.com",
		PrivateKey:  string(encoded),
		TokenURI:    tokenURI,
	}
}

// tokenServer answers the OAuth exchange, counting how often it was asked.
func tokenServer(t *testing.T, expiresIn int64, calls *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		if err := r.ParseForm(); err != nil {
			t.Errorf("bad form: %v", err)
		}
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
			t.Errorf("unexpected grant type %q", r.Form.Get("grant_type"))
		}
		if r.Form.Get("assertion") == "" {
			t.Error("no signed assertion was sent")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at-1", "expires_in": expiresIn})
	}))
}

func TestSendPostsADataOnlyMessage(t *testing.T) {
	calls := 0
	tokens := tokenServer(t, 3600, &calls)
	defer tokens.Close()

	var got map[string]any
	var auth string
	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusOK)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("ciphertext")); err != nil {
		t.Fatal(err)
	}

	if auth != "Bearer at-1" {
		t.Fatalf("expected the minted token on the request, got %q", auth)
	}

	message := got["message"].(map[string]any)
	if message["token"] != "device-token" {
		t.Fatalf("wrong target: %v", message["token"])
	}
	// data, never notification: a notification block would have the
	// platform render text the relay cannot read.
	if _, hasNotification := message["notification"]; hasNotification {
		t.Fatal("a notification block would bypass the device's own decryption")
	}
	data := message["data"].(map[string]any)
	if data["payload"] != base64.StdEncoding.EncodeToString([]byte("ciphertext")) {
		t.Fatalf("payload did not survive: %v", data["payload"])
	}
	if data["pushRoutingId"] != "routing-1" {
		t.Fatalf("the device needs the routing id to find its circle, got %v", data["pushRoutingId"])
	}
	if data["keyVersion"] != "3" {
		t.Fatalf("the device needs the key version, got %v", data["keyVersion"])
	}
	if data["placeholder"] != push.Placeholder {
		t.Fatalf("expected the fixed placeholder, got %v", data["placeholder"])
	}
	// Or Doze defers a data-only message indefinitely.
	if message["android"].(map[string]any)["priority"] != "high" {
		t.Fatal("expected high priority")
	}
}

/** A token lasts an hour and a cold start serves many sends. */
func TestAccessTokenIsReusedAcrossSends(t *testing.T) {
	calls := 0
	tokens := tokenServer(t, 3600, &calls)
	defer tokens.Close()

	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	for range 3 {
		if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}

	if calls != 1 {
		t.Fatalf("expected one token exchange, got %d", calls)
	}
}

// A token expiring within the refresh margin must be replaced before use,
// not after a send has already failed on it.
func TestAnAlmostExpiredTokenIsRefreshed(t *testing.T) {
	calls := 0
	tokens := tokenServer(t, 60, &calls)
	defer tokens.Close()

	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	for range 2 {
		if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}

	if calls != 2 {
		t.Fatalf("a token inside the refresh margin should have been re-minted, got %d exchanges", calls)
	}
}

func TestSendReportsAFailedStatus(t *testing.T) {
	calls := 0
	tokens := tokenServer(t, 3600, &calls)
	defer tokens.Close()

	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":{"message":"registration token not found: device-token"}}`, http.StatusNotFound)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	err := sender.Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x"))
	if err == nil {
		t.Fatal("expected an error")
	}
	// The body names the device token, so only the status is reported.
	if strings.Contains(err.Error(), "device-token") {
		t.Fatalf("the error carried the device token: %v", err)
	}
}

func TestAMalformedKeyDoesNotLeakItself(t *testing.T) {
	account := &ServiceAccount{
		ProjectID:   "circle-test",
		ClientEmail: "sender@mimoza-test.iam.gserviceaccount.com",
		PrivateKey:  "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
	}

	err := New(account).Send(context.Background(), "device-token", "routing-1", push.KindCircle, 3, []byte("x"))
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "not-a-key") {
		t.Fatalf("the error quoted the key: %v", err)
	}
}

// redirectTo points every request at a test server, so Send can keep
// building the real fcm.googleapis.com URL.
func redirectTo(target string) http.RoundTripper {
	return roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.Host, "fcm.googleapis.com") {
			replacement, _ := http.NewRequest(req.Method, target, req.Body)
			replacement.Header = req.Header
			return http.DefaultTransport.RoundTrip(replacement)
		}
		return http.DefaultTransport.RoundTrip(req)
	})
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

var _ = time.Second

func TestSendAttachesTheKindsLine(t *testing.T) {
	calls := 0
	tokens := tokenServer(t, 3600, &calls)
	defer tokens.Close()
	var got map[string]any
	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusOK)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	if err := sender.Send(context.Background(), "device-token", "routing-1", push.KindPendingRequest, 0, []byte("x")); err != nil {
		t.Fatal(err)
	}

	data := got["message"].(map[string]any)["data"].(map[string]any)
	if data["placeholder"] != push.KindPendingRequest.Alert() {
		t.Fatalf("expected the pending request line, got %v", data["placeholder"])
	}
	if data["kind"] != string(push.KindPendingRequest) {
		t.Fatalf("expected the kind, got %v", data["kind"])
	}
}
