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

// Every card ships data-only (see Send's doc comment for why): the loc
// keys and args ride in data for push-localization/android to resolve
// against the app's own strings.xml, same as the rest of the data.
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
	if _, carries := android["notification"]; carries {
		t.Error("a card must still ship data-only, not FCM's own notification block")
	}
	if android["priority"] != "high" {
		t.Errorf("a data message at normal priority is deferred by Doze: %v", android)
	}
	data, _ := message["data"].(map[string]any)
	// Dotted as compose.go names them, matching iOS's own Localizable.strings
	// convention — but aapt2 rejects a "." in a resource name, so Android's
	// own copy has to lose it. See TestSendUnderscoresLocKeysForAndroid.
	if data["bodyLocKey"] != "push_posted" || data["titleLocKey"] != "push_title_circle" {
		t.Fatalf("data = %v", data)
	}
	var args []string
	if err := json.Unmarshal([]byte(data["locArgs"].(string)), &args); err != nil {
		t.Fatalf("locArgs wasn't a JSON array: %v (%v)", data["locArgs"], err)
	}
	if len(args) != 2 || args[0] != "Sarah" || args[1] != "Family" {
		t.Errorf("locArgs = %v", args)
	}
	if data["circleId"] != "circle-1" || data["entryId"] != "post-1" {
		t.Errorf("data = %v", data)
	}
}

// Android's resource compiler refuses a "." in a string resource's name.
// compose.go's keys are dotted to match iOS's Localizable.strings
// convention, so the copy Android looks titleLocKey/bodyLocKey up
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
	data, _ := envelope["data"].(map[string]any)
	if data["titleLocKey"] != "push_title_account" || data["bodyLocKey"] != "push_rewrap_needed" {
		t.Fatalf("data = %v", data)
	}
}

// A silent push carries none of the loc-key/args/body scaffolding a card
// needs: push-localization/android (and, in the foreground, the app's
// own setNotificationHandler) both treat a title-and-body-less message
// as nothing to show, and the app just wakes to sync.
func TestSendPostsASilentMessageWithNoCardFields(t *testing.T) {
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
	data, _ := envelope["data"].(map[string]any)
	if _, has := data["titleLocKey"]; has {
		t.Errorf("a silent push must carry no loc keys: %v", data)
	}
}

// The app's own PresentationDelegate override groups notifications by
// circle, but expo-notifications only resolves arbitrary data back out
// through a data.body field holding its own JSON object — the relay has
// to speak that convention for the grouping to see the circle id at all.
func TestSendCarriesCircleIdForAndroidGrouping(t *testing.T) {
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
	data, _ := message["data"].(map[string]any)
	var body map[string]string
	if err := json.Unmarshal([]byte(data["body"].(string)), &body); err != nil {
		t.Fatalf("data.body wasn't a JSON object: %v (%v)", data["body"], err)
	}
	if body["circleId"] != "circle-1" {
		t.Errorf("body = %v", body)
	}
}

// A valid-JSON data.body makes Android's own NotificationSerializer
// treat the message as Expo-service-formatted and expose *only* body's
// contents as a tapped notification's data — so body has to carry every
// field a tap needs to route to the right screen (entryId included),
// not just circleId, or a tap silently loses everywhere but the circle.
func TestSendsBodyCarriesEveryFieldATapNeeds(t *testing.T) {
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
	data, _ := message["data"].(map[string]any)
	var body map[string]string
	if err := json.Unmarshal([]byte(data["body"].(string)), &body); err != nil {
		t.Fatalf("data.body wasn't a JSON object: %v (%v)", data["body"], err)
	}
	if body["entryId"] != "post-1" {
		t.Errorf("a tap needs the post it is on, and body is the only place Android's tap handler looks once it's valid JSON: %v", body)
	}
}

// A silent push has no notification to group, and fanout.go reuses one
// Message, Data map included, across every device of a recipient — so
// adding "body" here must never mutate the caller's map, or a later
// send (to this same device, or an iOS one) would see it unexpectedly.
func TestSendDoesNotMutateTheSharedDataMap(t *testing.T) {
	tokens := tokenServer(t, 3600, new(int))
	defer tokens.Close()

	fcmAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer fcmAPI.Close()

	sender := New(testAccount(t, tokens.URL))
	sender.Client.Transport = redirectTo(fcmAPI.URL)

	message := testMessage()
	if err := sender.Send(context.Background(), "device-token", message); err != nil {
		t.Fatal(err)
	}

	if _, mutated := message.Data["body"]; mutated {
		t.Error("Send must not add to the caller's Data map")
	}
}
