package fcm

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
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
		if err := sender.Send(context.Background(), "device-token", testMessage()); err != nil {
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
		if err := sender.Send(context.Background(), "device-token", testMessage()); err != nil {
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

	err := sender.Send(context.Background(), "device-token", testMessage())
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

	err := New(account).Send(context.Background(), "device-token", testMessage())
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

// The card is localization keys, which Android renders against the app's
// own strings.xml, and the data rides alongside for the tap.
func TestSendPostsLocalizationKeys(t *testing.T) {
	tokens := tokenServer(t, 3600, new(int))
	defer tokens.Close()

	var got map[string]any
	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	if err := sender.Send(context.Background(), "device-token", testMessage()); err != nil {
		t.Fatal(err)
	}

	message, _ := got["message"].(map[string]any)
	android, _ := message["android"].(map[string]any)
	notification, _ := android["notification"].(map[string]any)
	// Dotted as compose.go names them, matching iOS's own Localizable.strings
	// convention — but aapt2 rejects a "." in a resource name, so Android's
	// own copy has to lose it. See TestSendUnderscoresLocKeysForAndroid.
	if notification["body_loc_key"] != "push_posted" || notification["title_loc_key"] != "push_title_circle" {
		t.Fatalf("notification = %v", notification)
	}
	if android["priority"] != "high" {
		t.Errorf("a data message at normal priority is deferred by Doze: %v", android)
	}
	data, _ := message["data"].(map[string]any)
	if data["circleId"] != "circle-1" || data["entryId"] != "post-1" {
		t.Errorf("data = %v", data)
	}
}

// Android's resource compiler refuses a "." in a string resource's name.
// compose.go's keys are dotted to match iOS's Localizable.strings
// convention, so the copy Android looks title_loc_key/body_loc_key up
// against has to be the underscored one, not what iOS gets sent.
func TestSendUnderscoresLocKeysForAndroid(t *testing.T) {
	tokens := tokenServer(t, 3600, new(int))
	defer tokens.Close()

	var got map[string]any
	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	message := testMessage()
	message.TitleKey = "push.title_account"
	message.BodyKey = "push.rewrap_needed"
	if err := sender.Send(context.Background(), "device-token", message); err != nil {
		t.Fatal(err)
	}

	envelope, _ := got["message"].(map[string]any)
	android, _ := envelope["android"].(map[string]any)
	notification, _ := android["notification"].(map[string]any)
	if notification["title_loc_key"] != "push_title_account" || notification["body_loc_key"] != "push_rewrap_needed" {
		t.Fatalf("notification = %v", notification)
	}
}

// A silent push is data only: no notification block, so the platform
// renders nothing and the app wakes to sync.
func TestSendPostsASilentMessageWithNoNotification(t *testing.T) {
	tokens := tokenServer(t, 3600, new(int))
	defer tokens.Close()

	var got map[string]any
	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	message := testMessage()
	message.Silent = true
	if err := sender.Send(context.Background(), "device-token", message); err != nil {
		t.Fatal(err)
	}

	envelope, _ := got["message"].(map[string]any)
	android, _ := envelope["android"].(map[string]any)
	if _, carries := android["notification"]; carries {
		t.Error("a silent push must carry no notification block")
	}
}
