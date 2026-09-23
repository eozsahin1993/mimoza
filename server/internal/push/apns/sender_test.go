package apns

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
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
		if err := sender.Send(context.Background(), "device-token", testMessage()); err != nil {
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

	if err := sender.Send(context.Background(), "device-token", testMessage()); err != nil {
		t.Fatal(err)
	}
	sender.tokens.expiresAt = time.Now().Add(-time.Hour)
	if err := sender.Send(context.Background(), "device-token", testMessage()); err != nil {
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

	err := sender.Send(context.Background(), "device-token", testMessage())
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

	err := New(key, "com.eozsahin.mimoza", false).Send(context.Background(), "device-token", testMessage())
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

// testMessage is an ordinary card: the loc keys and the args a device
// renders them with.
func testMessage() push.Message {
	return push.Message{
		TitleKey: "push.title_circle",
		BodyKey:  "push.posted",
		Args:     []string{"Sarah", "Family"},
		Data:     map[string]string{"circleId": "circle-1", "entryId": "post-1"},
	}
}

// The card is localization keys and arguments, never text: iOS renders
// it against the app's own strings, which is why no extension ships.
func TestSendPostsLocalizationKeys(t *testing.T) {
	var got map[string]any
	var headers http.Header
	apnsAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = r.Header.Clone()
		_ = json.NewDecoder(r.Body).Decode(&got)
	}))
	defer apnsAPI.Close()

	sender := New(testKey(t), "com.eozsahin.mimoza", false)
	sender.Client = apnsAPI.Client()
	sender.Production = false
	transport := apnsAPI.Client().Transport
	sender.Client = &http.Client{Transport: rewriteHost{to: apnsAPI.URL, inner: transport}}

	if err := sender.Send(context.Background(), "device-token", testMessage()); err != nil {
		t.Fatal(err)
	}

	if headers.Get("apns-push-type") != "alert" || headers.Get("apns-priority") != "10" {
		t.Errorf("headers = %v", headers)
	}
	aps, _ := got["aps"].(map[string]any)
	alert, _ := aps["alert"].(map[string]any)
	if alert["loc-key"] != "push.posted" || alert["title-loc-key"] != "push.title_circle" {
		t.Fatalf("alert = %v", alert)
	}
	args, _ := alert["loc-args"].([]any)
	if len(args) != 2 || args[0] != "Sarah" {
		t.Errorf("loc-args = %v", args)
	}
	if _, carries := aps["content-available"]; carries {
		t.Error("an ordinary card must not also be a silent push")
	}
	// The body is never in the payload: the relay cannot read it.
	body, _ := json.Marshal(got)
	if strings.Contains(string(body), "ciphertext") || strings.Contains(string(body), "payload") {
		t.Errorf("payload carries content: %s", body)
	}
	data, _ := got["data"].(map[string]any)
	if data["circleId"] != "circle-1" {
		t.Errorf("data = %v", data)
	}
}

// A silent push carries no card. Apple throttles these and drops them
// after a force quit, so nothing user-visible depends on one arriving.
func TestSendPostsASilentPushWithNoAlert(t *testing.T) {
	var got map[string]any
	var headers http.Header
	apnsAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = r.Header.Clone()
		_ = json.NewDecoder(r.Body).Decode(&got)
	}))
	defer apnsAPI.Close()

	sender := New(testKey(t), "com.eozsahin.mimoza", false)
	sender.Client = &http.Client{Transport: rewriteHost{to: apnsAPI.URL, inner: apnsAPI.Client().Transport}}

	message := testMessage()
	message.Silent = true
	if err := sender.Send(context.Background(), "device-token", message); err != nil {
		t.Fatal(err)
	}

	if headers.Get("apns-push-type") != "background" || headers.Get("apns-priority") != "5" {
		t.Errorf("headers = %v", headers)
	}
	aps, _ := got["aps"].(map[string]any)
	if _, carries := aps["alert"]; carries {
		t.Error("a silent push must carry no alert")
	}
	if aps["content-available"] != float64(1) {
		t.Errorf("aps = %v", aps)
	}
}

// rewriteHost points the sender's fixed Apple host at the test server.
type rewriteHost struct {
	to    string
	inner http.RoundTripper
}

func (r rewriteHost) RoundTrip(request *http.Request) (*http.Response, error) {
	target, err := url.Parse(r.to)
	if err != nil {
		return nil, err
	}
	request.URL.Scheme, request.URL.Host = target.Scheme, target.Host
	return r.inner.RoundTrip(request)
}
