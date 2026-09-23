// End-to-end tests for the push routes, against the fully assembled
// router — see router_test.go's top comment for why this is separate from
// the per-package unit tests.
package app_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mimoza-relay/internal/push"
	pushhttp "mimoza-relay/internal/push/http"
	"mimoza-relay/internal/util/testsupport"
)

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func jsonBody(b []byte) io.Reader { return bytes.NewReader(b) }

// ownerOf is the owner token a test account presents for a routing id.
// Real clients derive it from their seed; a hash stands in here. Not a
// copy of the id: test ids share a long prefix, and truncating them to 32
// bytes gave two addresses the same token.
func ownerOf(pushRoutingID string) []byte {
	sum := sha256.Sum256([]byte(pushRoutingID))
	return sum[:]
}

// ownedRequest is authedRequest plus the owner header every push write needs.
func ownedRequest(t *testing.T, method, url, token string, owner []byte, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set(pushhttp.OwnerHeader, b64(owner))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// registerPush puts a routing id's prefs and one device in place, and
// returns the fanout token a sender would need for it.
func registerPush(t *testing.T, serverURL, token, pushRoutingID string) []byte {
	t.Helper()
	pushFanoutToken := []byte("fanout-token-for-" + pushRoutingID)

	body, err := json.Marshal(map[string]any{
		"kind":           "circle",
		"pushFanoutHash": b64(push.PushFanoutHash(pushFanoutToken, pushRoutingID)),
		"categories":     []int64{0, 1},
		"keyVersion":     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	resp := ownedRequest(t, http.MethodPut, serverURL+"/v1/push/"+pushRoutingID, token, ownerOf(pushRoutingID), string(body))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT prefs, got %d", resp.StatusCode)
	}

	deviceBody, err := json.Marshal(map[string]any{
		"pushToken": b64([]byte("encrypted-token")),
		"platform":  "ios",
		"enabled":   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	deviceResp := ownedRequest(t, http.MethodPut, serverURL+"/v1/push/"+pushRoutingID+"/devices/device-1", token, ownerOf(pushRoutingID), string(deviceBody))
	defer deviceResp.Body.Close()
	if deviceResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT device, got %d", deviceResp.StatusCode)
	}
	return pushFanoutToken
}

func sendPush(t *testing.T, serverURL string, pushRoutingIDs []string, pushFanoutToken []byte, category int64) (int, map[string]int) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"pushRoutingIds":  pushRoutingIDs,
		"pushFanoutToken": b64(pushFanoutToken),
		"category":        category,
		"payload":         b64([]byte("ciphertext")),
	})
	if err != nil {
		t.Fatal(err)
	}

	// Deliberately no bearer token: this route authorizes on the fanout
	// token instead. See push/http's FanoutHandler.
	resp, err := http.Post(serverURL+"/v1/push/send", "application/json", jsonBody(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil
	}
	var decoded map[string]int
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, decoded
}

func TestEndToEnd_Push_RegisterRequiresAuth(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Post(server.URL+"/v1/push/some-routing-id", "application/json", jsonBody([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("registration must require a session")
	}
}

// The one route that must stay reachable without a session — and the one
// most likely to be broken by a change to the "/push/" pattern.
func TestEndToEnd_Push_SendDoesNotRequireAuth(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	pushRoutingID := testsupport.UniqueInviteTag(t)
	pushFanoutToken := registerPush(t, server.URL, token, pushRoutingID)

	status, result := sendPush(t, server.URL, []string{pushRoutingID}, pushFanoutToken, 0)
	if status != http.StatusOK {
		t.Fatalf("expected 200 from an unauthenticated send, got %d", status)
	}
	if result["delivered"] != 1 {
		t.Fatalf("expected 1 delivery, got %+v", result)
	}
}

func TestEndToEnd_Push_WrongFanoutTokenDeliversNothing(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	pushRoutingID := testsupport.UniqueInviteTag(t)
	registerPush(t, server.URL, token, pushRoutingID)

	status, result := sendPush(t, server.URL, []string{pushRoutingID}, []byte("another-circles-token"), 0)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	// 200 with nothing delivered, not an error: the caller must not learn
	// whether the routing id exists.
	if result["delivered"] != 0 || result["skipped"] != 1 {
		t.Fatalf("expected nothing delivered, got %+v", result)
	}
}

func TestEndToEnd_Push_UnregisteringSilencesTheCircle(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	pushRoutingID := testsupport.UniqueInviteTag(t)
	pushFanoutToken := registerPush(t, server.URL, token, pushRoutingID)

	deleteResp := ownedRequest(t, http.MethodDelete, server.URL+"/v1/push/"+pushRoutingID, token, ownerOf(pushRoutingID), "")
	defer deleteResp.Body.Close()
	if deleteResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from DELETE, got %d", deleteResp.StatusCode)
	}

	_, result := sendPush(t, server.URL, []string{pushRoutingID}, pushFanoutToken, 0)
	if result["delivered"] != 0 {
		t.Fatalf("a silenced circle must deliver nothing, got %+v", result)
	}
}

func TestEndToEnd_Push_RejectsShortFanoutHash(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	body, _ := json.Marshal(map[string]any{"kind": "circle", "pushFanoutHash": b64([]byte("short")), "categories": []int64{0}})
	pushRoutingID := testsupport.UniqueInviteTag(t)
	resp := ownedRequest(t, http.MethodPut, server.URL+"/v1/push/"+pushRoutingID, token, ownerOf(pushRoutingID), string(body))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a short pushFanoutHash, got %d", resp.StatusCode)
	}
}

// The attack ownership exists for: another member reads a routing id from
// the roster and tries to silence or take over the address.
func TestEndToEnd_Push_AnotherAccountCannotChangeARoutingID(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	signIn := func() string {
		claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
		claims["iss"] = google.Issuer
		return decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))
	}
	owner, other := signIn(), signIn()

	pushRoutingID := testsupport.UniqueInviteTag(t)
	pushFanoutToken := registerPush(t, server.URL, owner, pushRoutingID)
	wrongOwner := []byte("somebody-elses-owner-token-32byt")
	url := server.URL + "/v1/push/" + pushRoutingID

	prefs, _ := json.Marshal(map[string]any{"kind": "circle", "pushFanoutHash": b64(make([]byte, 32)), "categories": []int64{0}})
	device, _ := json.Marshal(map[string]any{"pushToken": b64([]byte("attacker-token")), "platform": "ios", "enabled": true})
	for _, attempt := range []struct{ method, path, body string }{
		{http.MethodPut, "", string(prefs)},
		{http.MethodPut, "/devices/attacker", string(device)},
		{http.MethodPut, "/silenced", `{"silenced":true}`},
		{http.MethodDelete, "/devices/device-1", ""},
		{http.MethodDelete, "", ""},
	} {
		resp := ownedRequest(t, attempt.method, url+attempt.path, other, wrongOwner, attempt.body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s: expected 403, got %d", attempt.method, attempt.path, resp.StatusCode)
		}
	}

	_, result := sendPush(t, server.URL, []string{pushRoutingID}, pushFanoutToken, 0)
	if result["delivered"] != 1 {
		t.Fatalf("the owner should still get exactly their one device, got %+v", result)
	}
}

func TestEndToEnd_Push_WritesNeedTheOwnerHeader(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	resp := authedRequest(t, http.MethodDelete, server.URL+"/v1/push/"+testsupport.UniqueInviteTag(t), token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 without %s, got %d", pushhttp.OwnerHeader, resp.StatusCode)
	}
}

// A real member: registered, holding a genuine owner token for their own
// address, and knowing everyone else's routing id from the roster. Their
// token must open their row and nobody else's.
func TestEndToEnd_Push_AMemberCannotDeleteAnothersPushConfig(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	signIn := func() string {
		claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
		claims["iss"] = google.Issuer
		return decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))
	}
	victim, member := signIn(), signIn()

	victimRouting := testsupport.UniqueInviteTag(t)
	memberRouting := testsupport.UniqueInviteTag(t)
	victimFanout := registerPush(t, server.URL, victim, victimRouting)
	registerPush(t, server.URL, member, memberRouting)
	memberOwner := ownerOf(memberRouting)

	for _, path := range []string{"/devices/device-1", ""} {
		resp := ownedRequest(t, http.MethodDelete, server.URL+"/v1/push/"+victimRouting+path, member, memberOwner, "")
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("DELETE %s with another address's owner token: expected 403, got %d", path, resp.StatusCode)
		}
	}

	_, result := sendPush(t, server.URL, []string{victimRouting}, victimFanout, 0)
	if result["delivered"] != 1 {
		t.Fatalf("the victim's device and prefs should be untouched, got %+v", result)
	}

	// The same token still works where it belongs.
	resp := ownedRequest(t, http.MethodDelete, server.URL+"/v1/push/"+memberRouting, member, memberOwner, "")
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a member deleting their own routing: expected 200, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_Push_KindIsRequired(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	for _, kind := range []string{"", "someone-else"} {
		body, _ := json.Marshal(map[string]any{"kind": kind, "pushFanoutHash": b64(make([]byte, 32)), "categories": []int64{0}})
		pushRoutingID := testsupport.UniqueInviteTag(t)
		resp := ownedRequest(t, http.MethodPut, server.URL+"/v1/push/"+pushRoutingID, token, ownerOf(pushRoutingID), string(body))
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("kind %q: expected 400, got %d", kind, resp.StatusCode)
		}
	}
}

// A pending request's push needs no ciphertext: the requester's phone
// writes the text from its own row. An empty payload must still deliver.
func TestEndToEnd_Push_AnEmptyPayloadStillDelivers(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	pushRoutingID := testsupport.UniqueInviteTag(t)
	pushFanoutToken := registerPush(t, server.URL, token, pushRoutingID)

	body, _ := json.Marshal(map[string]any{
		"pushRoutingIds":  []string{pushRoutingID},
		"pushFanoutToken": b64(pushFanoutToken),
		"category":        0,
		"payload":         "",
	})
	resp, err := http.Post(server.URL+"/v1/push/send", "application/json", jsonBody(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var result map[string]int
	_ = json.NewDecoder(resp.Body).Decode(&result)
	if resp.StatusCode != http.StatusOK || result["delivered"] != 1 {
		t.Fatalf("expected one delivery, got %d %+v", resp.StatusCode, result)
	}
}
