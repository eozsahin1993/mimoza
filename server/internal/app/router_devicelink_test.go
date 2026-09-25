// End-to-end tests for the device-link handshake, against the fully
// assembled router — see helpers_test.go's top comment for why this is
// separate from the per-package unit tests.
package app_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/util/testsupport"
)

type linkBody struct {
	SessionID     string `json:"sessionId"`
	PublicKey     string `json:"publicKey"`
	SealedKeypair string `json:"sealedKeypair"`
	ExpiresAt     int64  `json:"expiresAt"`
}

func decodeLink(t *testing.T, resp *http.Response) linkBody {
	t.Helper()
	defer resp.Body.Close()
	var body linkBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

// signIn mints a session for a fresh account, or for the same identity
// again — which is what a second device of one account is.
func signIn(t *testing.T, server *httptest.Server, google *testsupport.FakeOIDCProvider, email, subject string) string {
	t.Helper()
	claims := validClaims(t, email, testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	if subject != "" {
		claims["sub"] = subject
	}
	return decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))
}

func openSession(t *testing.T, server *httptest.Server, token string, publicKey []byte) linkBody {
	t.Helper()
	body := `{"publicKey":"` + base64.StdEncoding.EncodeToString(publicKey) + `"}`
	resp := authedRequest(t, http.MethodPost, server.URL+"/v1/account/device-link", token, body)
	if resp.StatusCode != http.StatusCreated {
		resp.Body.Close()
		t.Fatalf("expected 201 from opening a session, got %d", resp.StatusCode)
	}
	return decodeLink(t, resp)
}

// The whole handshake: the new phone opens a session, the phone that
// already holds the keypair answers it, and the new phone collects.
func TestEndToEnd_DeviceLink_CarriesTheKeypairBetweenTwoDevices(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	email := testsupport.UniqueEmail(t)
	// The same provider subject signed in twice is one account on two
	// phones, which is the only shape this handshake ever runs in.
	subject := testsupport.UniqueAccountID(t)
	newPhone := signIn(t, server, google, email, subject)
	oldPhone := signIn(t, server, google, email, subject)

	publicKey := bytes.Repeat([]byte{3}, accounts.X25519KeyLength)
	session := openSession(t, server, newPhone, publicKey)
	if session.SessionID == "" || session.ExpiresAt == 0 {
		t.Fatalf("expected a session id and an expiry, got %+v", session)
	}

	// Nothing to collect until the other phone answers.
	pending := decodeLink(t, authedRequest(t, http.MethodGet, server.URL+"/v1/account/device-link/"+session.SessionID, newPhone, ""))
	if pending.SealedKeypair != "" {
		t.Error("expected no sealed keypair before the other device answered")
	}
	if pending.PublicKey != base64.StdEncoding.EncodeToString(publicKey) {
		t.Errorf("the session should echo the key it was opened with, got %q", pending.PublicKey)
	}

	sealed := base64.StdEncoding.EncodeToString([]byte("sealed-to-the-throwaway-key"))
	deliver := authedRequest(t, http.MethodPost, server.URL+"/v1/account/device-link/"+session.SessionID, oldPhone,
		`{"sealedKeypair":"`+sealed+`"}`)
	deliver.Body.Close()
	if deliver.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 from delivering, got %d", deliver.StatusCode)
	}

	collected := decodeLink(t, authedRequest(t, http.MethodGet, server.URL+"/v1/account/device-link/"+session.SessionID, newPhone, ""))
	if collected.SealedKeypair != sealed {
		t.Errorf("collected %q, want %q", collected.SealedKeypair, sealed)
	}
}

// The key shape is the access check. A device of another account naming
// the session id addresses a row in its own partition, which is empty.
func TestEndToEnd_DeviceLink_IsInvisibleToAnotherAccount(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	mine := signIn(t, server, google, testsupport.UniqueEmail(t), "")
	theirs := signIn(t, server, google, testsupport.UniqueEmail(t), "")
	session := openSession(t, server, mine, bytes.Repeat([]byte{3}, accounts.X25519KeyLength))

	read := authedRequest(t, http.MethodGet, server.URL+"/v1/account/device-link/"+session.SessionID, theirs, "")
	read.Body.Close()
	if read.StatusCode != http.StatusNotFound {
		t.Errorf("another account read the session: got %d, want 404", read.StatusCode)
	}

	answer := authedRequest(t, http.MethodPost, server.URL+"/v1/account/device-link/"+session.SessionID, theirs,
		`{"sealedKeypair":"`+base64.StdEncoding.EncodeToString([]byte("theirs"))+`"}`)
	answer.Body.Close()
	if answer.StatusCode != http.StatusNotFound {
		t.Errorf("another account answered the session: got %d, want 404", answer.StatusCode)
	}
}

func TestEndToEnd_DeviceLink_RefusesASecondAnswer(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	token := signIn(t, server, google, testsupport.UniqueEmail(t), "")
	session := openSession(t, server, token, bytes.Repeat([]byte{3}, accounts.X25519KeyLength))
	body := `{"sealedKeypair":"` + base64.StdEncoding.EncodeToString([]byte("first")) + `"}`

	first := authedRequest(t, http.MethodPost, server.URL+"/v1/account/device-link/"+session.SessionID, token, body)
	first.Body.Close()
	if first.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 from the first answer, got %d", first.StatusCode)
	}

	second := authedRequest(t, http.MethodPost, server.URL+"/v1/account/device-link/"+session.SessionID, token, body)
	second.Body.Close()
	if second.StatusCode != http.StatusConflict {
		t.Errorf("expected 409 from a second answer, got %d", second.StatusCode)
	}
}

// A key that cannot be an X25519 key is refused at the edge, so a
// session can never be opened against something nothing can seal to.
func TestEndToEnd_DeviceLink_RefusesAKeyOfTheWrongSize(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	token := signIn(t, server, google, testsupport.UniqueEmail(t), "")
	for _, body := range []string{
		`{"publicKey":"` + base64.StdEncoding.EncodeToString([]byte("too-short")) + `"}`,
		`{"publicKey":"not base64 at all"}`,
		`{"publicKey":""}`,
	} {
		resp := authedRequest(t, http.MethodPost, server.URL+"/v1/account/device-link", token, body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("expected 400 for %s, got %d", body, resp.StatusCode)
		}
	}
}
