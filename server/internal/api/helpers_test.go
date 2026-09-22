// End-to-end tests against the fully assembled router — real HTTP
// requests in, real HTTP responses out, real adapters against LocalStack
// underneath. Not covered by the per-package unit tests, which call
// service methods directly and never exercise routing, JSON encoding or
// base64 handling.
package api_test

import (
	"net/http"
	"strings"
	"testing"
)

// authedRequest sets the bearer token every session-gated route needs —
// http.Post and http.Get cannot set headers, so this replaces them here.
func authedRequest(t *testing.T, method, url, token, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}
