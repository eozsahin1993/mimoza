// Package harness drives a relay the way a client does: over HTTP, with
// no access to anything inside it. Not for handler coverage — internal/api's
// own tests already have that — but for the sequences between calls, where
// a client's real problems live: create an invite, request against it,
// approve, then find the approval readable when it shouldn't be.
//
// The relay is blind (SYNC_DESIGN invariant 3), so an entry body is any
// bytes at all — no client crypto to reproduce, nothing to drift out of
// step with the app. Each Start gets its own relay over its own tables
// (see localstack.Unique), so an assertion can claim a list holds exactly
// one row rather than merely holding its own.
//
// Its own importable package, not more *_test.go files beside the tests
// that use it: Relay/Device/Response are generic to any sequence a future
// test package writes against this relay. Circle (see circle.go) is the
// one thing here that knows a specific flow, and earns its place by being
// shared across test files rather than living in one of them — the invite
// steps, used by a single file, stay in invite_test.go.
package harness

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"mimoza-relay/internal/accounts"
	accountsdynamo "mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/api"
	"mimoza-relay/internal/app"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/localstack"
)

// sessionTTL only has to outlast one test.
const sessionTTL = time.Hour

// requestTimeout bounds every request this package sends. Generous enough
// for a real handler plus its own DynamoDB/S3 calls; short enough that a
// hung relay fails the one request that hung, not the whole test binary.
const requestTimeout = 30 * time.Second

// Relay is a running relay and the means to talk to it. It carries the
// test, so nothing downstream has to be handed one again.
type Relay struct {
	t       *testing.T
	baseURL string
	// sessions is how SignIn gets a bearer token in without a round trip,
	// when this package also owns the store: nil when RELAY_URL points
	// at somebody else's relay, since minting a session there through a
	// store this process can't reach would be minting it in the wrong
	// place. SignIn falls back to /testonly/session in that case — see
	// registerTestOnly in cmd/testrelay, which every RELAY_URL target is
	// expected to expose.
	sessions auth.Store
	// accounts is where an account id comes from, as it does for a real
	// sign-in: minting a session against an id the accounts column never
	// issued would leave a device with no profile.
	accounts *accountsdynamo.Table
}

// Start builds a relay of this test's own and registers its teardown.
// httptest.NewServer, not the mux directly, so requests cross a real
// socket. Set RELAY_URL to aim at a running cmd/testrelay instead — no
// local LocalStack access needed, since SignIn mints sessions through
// that relay's own /testonly/session rather than writing to a store here.
func Start(t *testing.T) *Relay {
	t.Helper()

	if baseURL := os.Getenv("RELAY_URL"); baseURL != "" {
		return &Relay{t: t, baseURL: baseURL}
	}

	ctx := context.Background()

	awsCfg, err := localstack.Config(ctx)
	if err != nil {
		unreachable(t, err)
	}

	ddb := awsdynamodb.NewFromConfig(awsCfg)
	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = true })

	names := localstack.Unique(Suffix())
	if err := localstack.ProvisionSet(ctx, ddb, s3Client, names); err != nil {
		unreachable(t, err)
	}
	t.Cleanup(func() { localstack.TeardownSet(context.Background(), ddb, s3Client, names) })

	deps := app.Deps(localstack.RelayConfig(names), awsCfg)
	server := httptest.NewServer(api.NewRouter(deps))
	t.Cleanup(server.Close)

	return &Relay{t: t, baseURL: server.URL, sessions: deps.Auth, accounts: deps.Accounts}
}

// unreachable skips, or fails when the environment says a missing
// LocalStack is a broken pipeline — see localstack.Required, which
// internal/util/testsupport consults for the same decision.
func unreachable(t *testing.T, err error) {
	t.Helper()
	if localstack.Required() {
		t.Fatalf("%s is set but the relay's storage is unreachable: %v", localstack.RequireEnv, err)
	}
	t.Skipf("LocalStack not reachable, skipping: %v", err)
}

// Device is one caller of the relay. Named for what it is on the relay's
// side: an account with a session, holding no circle state of its own.
type Device struct {
	relay *Relay
	token string
	// accountID is what the relay knows this device by — the value a
	// response carries as an author, a member or a recipient.
	accountID string
	identity  Authority
}

// AccountID is who the relay thinks this device is, for assertions about
// authorship and membership.
func (d *Device) AccountID() string { return d.accountID }

// SignIn mints a session for a fresh account, skipping Google and Apple.
// Provider verification is internal/api's business; what matters here is
// that requests carry a credential the relay accepts.
func (r *Relay) SignIn() *Device {
	r.t.Helper()
	return r.SignInAs(Suffix())
}

// SignInAs signs in as a particular person, which is what a returning
// device is: the same provider subject twice must land on the account
// the first sign-in minted, not a second one.
func (r *Relay) SignInAs(subject string) *Device {
	r.t.Helper()
	d := &Device{relay: r, token: Suffix(), identity: NewAuthority(r.t)}

	if r.sessions != nil {
		accountID, _, err := r.accounts.Resolve(context.Background(),
			accounts.Provider{Name: "testonly", Subject: subject})
		if err != nil {
			r.t.Fatalf("failed to resolve an account: %v", err)
		}
		d.accountID = accountID

		session := auth.Session{AccountID: accountID, ExpiresAt: time.Now().Add(sessionTTL)}
		if err := r.sessions.SaveSession(context.Background(), d.token, session); err != nil {
			r.t.Fatalf("failed to mint a session: %v", err)
		}
		d.publishKey()
		return d
	}

	// RELAY_URL mode: this process holds no store the target relay reads
	// from, so both the account and the session are made on its side —
	// see registerTestOnly in cmd/testrelay.
	var minted struct {
		AccountID string `json:"accountId"`
	}
	r.Anon().Post("/testonly/session", Body{"subject": subject, "token": d.token}).
		Expect(http.StatusOK).Decode(&minted)
	d.accountID = minted.AccountID
	d.publishKey()
	return d
}

// publishKey is what a real device does on its first launch: generate a
// keypair and publish the public half, so members have something to seal
// this account's content keys to. Asking to join a circle needs one, so
// a test device without it is not a device anyone could admit.
func (d *Device) publishKey() {
	d.relay.t.Helper()
	d.Put("/v1/account/pubkey", Body{
		"publicKey": base64.StdEncoding.EncodeToString([]byte(d.accountID + "-public-key")),
	}).Expect(http.StatusOK)
}

// Anon is a caller with no session, for the routes that must refuse one.
func (r *Relay) Anon() *Device {
	return &Device{relay: r}
}

// Body is a JSON object to send. A named type because almost every request
// here carries one field, and a bare map literal at each call site buries
// what's actually being sent. any, not string, because not every endpoint's
// fields are strings — keyVersion is a number wherever it appears, and
// quoting it doesn't decode as the wrong type, it fails the whole body as
// "invalid request body".
type Body map[string]any

func (d *Device) Get(path string) Response           { return d.send(http.MethodGet, path, nil) }
func (d *Device) Put(path string, b Body) Response   { return d.send(http.MethodPut, path, b) }
func (d *Device) Patch(path string, b Body) Response { return d.send(http.MethodPatch, path, b) }
func (d *Device) Post(path string, b Body) Response  { return d.send(http.MethodPost, path, b) }
func (d *Device) Delete(path string) Response        { return d.send(http.MethodDelete, path, nil) }

// PostRequest sends a struct rather than a Body — for the endpoints this
// package models field for field (see circle.go), where a map would drop
// the names the handler actually decodes and the types it needs them in.
func (d *Device) PostRequest(path string, request any) Response {
	return d.send(http.MethodPost, path, request)
}

func (d *Device) send(method, path string, b any) Response {
	t := d.relay.t
	t.Helper()

	var payload io.Reader
	if b != nil {
		encoded, err := json.Marshal(b)
		if err != nil {
			t.Fatalf("failed to encode the request body: %v", err)
		}
		payload = bytes.NewReader(encoded)
	}

	// Bounded rather than context.Background(): a hung relay or LocalStack
	// call otherwise blocks until the whole test binary's own -timeout
	// gives up, which reads as the suite stalling rather than naming which
	// request never returned.
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, method, d.relay.baseURL+path, payload)
	if err != nil {
		t.Fatalf("failed to build the request: %v", err)
	}
	if b != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if d.token != "" {
		req.Header.Set("Authorization", "Bearer "+d.token)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s failed: %v", method, path, err)
	}
	defer res.Body.Close()

	read, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("failed to read the response to %s %s: %v", method, path, err)
	}
	return Response{t: t, method: method, path: path, status: res.StatusCode, body: read}
}

// Response is one HTTP reply, kept whole so a test can assert on the
// status and the body without re-reading either — see AssertEqual and
// AssertTrue for comparisons that aren't about a response specifically.
type Response struct {
	t      *testing.T
	method string
	path   string
	status int
	body   []byte
}

// Expect fails unless the status matches, naming the request and quoting
// the body — where the relay says why, and the first thing anyone wants
// when this goes red.
func (res Response) Expect(status int) Response {
	res.t.Helper()
	if res.status != status {
		res.t.Fatalf("%s %s: got %d, want %d: %s", res.method, res.path, res.status, status, res.body)
	}
	return res
}

// Decode reads the body into target.
func (res Response) Decode(target any) Response {
	res.t.Helper()
	if err := json.Unmarshal(res.body, target); err != nil {
		res.t.Fatalf("%s %s: failed to decode %q: %v", res.method, res.path, res.body, err)
	}
	return res
}

// Bytes returns the raw response body — for a response that isn't JSON,
// like the ciphertext getblob's redirect ultimately resolves to.
func (res Response) Bytes() []byte {
	return res.body
}
