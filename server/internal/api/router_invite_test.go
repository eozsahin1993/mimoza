// End-to-end tests for the invite routes, against the fully
// assembled router — see router_test.go's top comment for why this is
// separate from the per-package unit tests.
package api_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"mimoza-relay/internal/util/testsupport"
)

func TestEndToEnd_Invite_RequiresAuth(t *testing.T) {
	mux := testsupport.NewRouter(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Get(server.URL + "/v1/invites/some-tag")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a bearer token, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_Invite_GetUnknownInviteReturns404(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	resp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+testsupport.UniqueInviteTag(t), token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for an invite tag that was never created, got %d", resp.StatusCode)
	}
}

// TestEndToEnd_Invite_FullRoundTrip walks the whole server-side
// handshake: create invite -> get invite -> put join request -> list
// requests -> approve -> get request shows the approval.
func TestEndToEnd_Invite_FullRoundTrip(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"

	preview := base64.StdEncoding.EncodeToString([]byte("pretend-encrypted-preview"))
	createInviteResp := authedRequest(t, http.MethodPost, server.URL+"/v1/invites", token, `{"inviteTag":"`+inviteTag+`","encryptedPreview":"`+preview+`"}`)
	defer createInviteResp.Body.Close()
	if createInviteResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from POST invite, got %d", createInviteResp.StatusCode)
	}

	getInviteResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+inviteTag, token, "")
	defer getInviteResp.Body.Close()
	if getInviteResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from GET invite, got %d", getInviteResp.StatusCode)
	}
	var getInviteBody struct {
		EncryptedPreview string `json:"encryptedPreview"`
	}
	if err := json.NewDecoder(getInviteResp.Body).Decode(&getInviteBody); err != nil {
		t.Fatal(err)
	}
	if getInviteBody.EncryptedPreview != preview {
		t.Fatalf("expected encryptedPreview %q, got %q", preview, getInviteBody.EncryptedPreview)
	}

	request := base64.StdEncoding.EncodeToString([]byte("pretend-encrypted-join-request"))
	putRequestResp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+inviteTag+"/requests/"+requesterID, token, `{"encryptedRequest":"`+request+`"}`)
	defer putRequestResp.Body.Close()
	if putRequestResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT join request, got %d", putRequestResp.StatusCode)
	}

	listResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+inviteTag+"/requests", token, "")
	defer listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from list requests, got %d", listResp.StatusCode)
	}
	var listBody struct {
		Requests []struct {
			RequesterID       string  `json:"requesterId"`
			EncryptedRequest  string  `json:"encryptedRequest"`
			EncryptedApproval *string `json:"encryptedApproval"`
			CreatedAt         int64   `json:"createdAt"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	if len(listBody.Requests) != 1 {
		t.Fatalf("expected 1 pending request, got %d", len(listBody.Requests))
	}
	if listBody.Requests[0].RequesterID != requesterID {
		t.Fatalf("expected requesterId %q, got %q", requesterID, listBody.Requests[0].RequesterID)
	}
	if listBody.Requests[0].EncryptedApproval != nil {
		t.Fatalf("expected no approval yet, got %q", *listBody.Requests[0].EncryptedApproval)
	}

	approval := base64.StdEncoding.EncodeToString([]byte("pretend-sealed-box-approval"))
	putApprovalResp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+inviteTag+"/requests/"+requesterID+"/approval", token, `{"encryptedApproval":"`+approval+`"}`)
	defer putApprovalResp.Body.Close()
	if putApprovalResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from PUT approval, got %d", putApprovalResp.StatusCode)
	}

	getRequestResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+inviteTag+"/requests/"+requesterID, token, "")
	defer getRequestResp.Body.Close()
	if getRequestResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from GET join request, got %d", getRequestResp.StatusCode)
	}
	var getRequestBody struct {
		RequesterID       string  `json:"requesterId"`
		EncryptedRequest  string  `json:"encryptedRequest"`
		EncryptedApproval *string `json:"encryptedApproval"`
		CreatedAt         int64   `json:"createdAt"`
	}
	if err := json.NewDecoder(getRequestResp.Body).Decode(&getRequestBody); err != nil {
		t.Fatal(err)
	}
	if getRequestBody.EncryptedApproval == nil || *getRequestBody.EncryptedApproval != approval {
		t.Fatalf("expected approval %q, got %v", approval, getRequestBody.EncryptedApproval)
	}
}

func TestEndToEnd_Invite_GetUnknownRequestReturns404(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	resp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+testsupport.UniqueInviteTag(t)+"/requests/nobody", token, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for a requester that never submitted, got %d", resp.StatusCode)
	}
}

func TestEndToEnd_Invite_ApproveUnknownRequestReturns404(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	approval := base64.StdEncoding.EncodeToString([]byte("pretend-sealed-box-approval"))
	resp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+testsupport.UniqueInviteTag(t)+"/requests/nobody/approval", token, `{"encryptedApproval":"`+approval+`"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 approving a join request that was never made, got %d", resp.StatusCode)
	}
}

// TestEndToEnd_DeviceTransfer_NoPreviewRow walks the device-transfer
// handshake, which reuses these same routes with the parties swapped (see
// app/src/domain/usecases/account/device-transfer-payloads.ts).
//
// The one thing it exists to prove: a transfer never writes an invite
// preview row, because there is no circle to preview. Every step below
// therefore runs against a tag whose partition holds nothing but the one
// request row. If a future change made a request or an approval depend on
// its invite existing, this is what would catch it — the client would
// otherwise fail at the point where a master seed was being handed over.
func TestEndToEnd_DeviceTransfer_NoPreviewRow(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	transferTag := testsupport.UniqueInviteTag(t)
	requesterID := "transfer-requester"

	// The waiting device publishes its one-time public key. No preview.
	request := base64.StdEncoding.EncodeToString([]byte("pretend-encrypted-device-name"))
	putRequestResp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+transferTag+"/requests/"+requesterID, token, `{"encryptedRequest":"`+request+`"}`)
	defer putRequestResp.Body.Close()
	if putRequestResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 putting a request under a tag with no invite row, got %d", putRequestResp.StatusCode)
	}

	// The established device reads it back to name what it's about to trust.
	listResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+transferTag+"/requests", token, "")
	defer listResp.Body.Close()
	var listBody struct {
		Requests []struct {
			RequesterID      string `json:"requesterId"`
			EncryptedRequest string `json:"encryptedRequest"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	if len(listBody.Requests) != 1 || listBody.Requests[0].EncryptedRequest != request {
		t.Fatalf("expected the one request row back, got %+v", listBody.Requests)
	}

	// ...then seals the account to it.
	approval := base64.StdEncoding.EncodeToString([]byte("pretend-sealed-master-seed"))
	putApprovalResp := authedRequest(t, http.MethodPut, server.URL+"/v1/invites/"+transferTag+"/requests/"+requesterID+"/approval", token, `{"encryptedApproval":"`+approval+`"}`)
	defer putApprovalResp.Body.Close()
	if putApprovalResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 approving under a tag with no invite row, got %d", putApprovalResp.StatusCode)
	}

	getResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+transferTag+"/requests/"+requesterID, token, "")
	defer getResp.Body.Close()
	var getBody struct {
		EncryptedApproval *string `json:"encryptedApproval"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&getBody); err != nil {
		t.Fatal(err)
	}
	if getBody.EncryptedApproval == nil || *getBody.EncryptedApproval != approval {
		t.Fatalf("expected the sealed payload back, got %v", getBody.EncryptedApproval)
	}

	// The waiting device clears the row once it has consumed the payload.
	deleteResp := authedRequest(t, http.MethodDelete, server.URL+"/v1/invites/"+transferTag+"/requests/"+requesterID, token, "")
	defer deleteResp.Body.Close()
	if deleteResp.StatusCode != http.StatusOK && deleteResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected the transfer row to be deletable, got %d", deleteResp.StatusCode)
	}

	afterResp := authedRequest(t, http.MethodGet, server.URL+"/v1/invites/"+transferTag+"/requests/"+requesterID, token, "")
	defer afterResp.Body.Close()
	if afterResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 once the sealed payload was cleared, got %d", afterResp.StatusCode)
	}
}
