// End-to-end tests for POST /v1/feedback against the assembled router:
// the session gate, the JSON contract and the validation answers, which
// the submit package's own tests never route through.
package app_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mimoza-relay/internal/util/testsupport"
)

func TestEndToEnd_Feedback(t *testing.T) {
	mux, google, _ := testsupport.NewRouterWithAuth(t)
	server := httptest.NewServer(mux)
	defer server.Close()

	claims := validClaims(t, testsupport.UniqueEmail(t), testsupport.TestGoogleClientID)
	claims["iss"] = google.Issuer
	token := decodeToken(t, postSignIn(t, server.URL, "/v1/auth/google", google.SignToken(t, claims)))

	t.Run("accepts a report", func(t *testing.T) {
		body := `{"kind":"bug","message":"  The feed is blank.  ","email":"me@example.com","context":{"appVersion":"1.0.0","build":"113.114","platform":"ios","osVersion":"26.0","device":"iPhone17,1","language":"en","environment":"staging"}}`
		resp := authedRequest(t, http.MethodPost, server.URL+"/v1/feedback", token, body)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("expected 201, got %d", resp.StatusCode)
		}
		var answer struct {
			ReportID string `json:"reportId"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
			t.Fatal(err)
		}
		if answer.ReportID == "" {
			t.Fatal("expected a report id")
		}
	})

	t.Run("refuses without a session", func(t *testing.T) {
		resp, err := http.Post(server.URL+"/v1/feedback", "application/json", strings.NewReader(`{"kind":"bug","message":"x"}`))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", resp.StatusCode)
		}
	})

	for name, body := range map[string]string{
		"not json":        `nope`,
		"unknown kind":    `{"kind":"rant","message":"x"}`,
		"empty message":   `{"kind":"bug","message":"   "}`,
		"message too big": `{"kind":"bug","message":"` + strings.Repeat("a", 4001) + `"}`,
		"bad email":       `{"kind":"bug","message":"x","email":"not an address"}`,
		"context too big": `{"kind":"bug","message":"x","context":{"device":"` + strings.Repeat("d", 201) + `"}}`,
	} {
		t.Run("refuses "+name, func(t *testing.T) {
			resp := authedRequest(t, http.MethodPost, server.URL+"/v1/feedback", token, body)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d", resp.StatusCode)
			}
		})
	}
}
