package httputil_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mimoza-relay/internal/util/httputil"
)

// Every call gets an id, and it comes back on the response so a client
// can quote it when something goes wrong.
func TestWithRequestID_MintsOneAndAnswersWithIt(t *testing.T) {
	var seen string
	handler := httputil.WithRequestID(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen = httputil.RequestID(r.Context())
	}))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/circles", nil))

	if seen == "" {
		t.Fatal("expected an id on the context")
	}
	if response.Header().Get("X-Request-Id") != seen {
		t.Errorf("header = %q, context = %q", response.Header().Get("X-Request-Id"), seen)
	}
}

// A caller's own id is kept, so their trace and ours line up.
func TestWithRequestID_KeepsTheCallersOwn(t *testing.T) {
	var seen string
	handler := httputil.WithRequestID(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen = httputil.RequestID(r.Context())
	}))

	request := httptest.NewRequest(http.MethodGet, "/v1/circles", nil)
	request.Header.Set("X-Request-Id", "caller-123")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	if seen != "caller-123" {
		t.Errorf("id = %q, want the caller's", seen)
	}
}

// A header is whatever someone sent, and it ends up in logs.
func TestWithRequestID_RefusesRubbish(t *testing.T) {
	for name, sent := range map[string]string{
		"a newline":    "abc\ndef",
		"a control":    "abc\x00def",
		"far too long": strings.Repeat("a", 65),
	} {
		var seen string
		handler := httputil.WithRequestID(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			seen = httputil.RequestID(r.Context())
		}))

		request := httptest.NewRequest(http.MethodGet, "/v1/circles", nil)
		request.Header.Set("X-Request-Id", sent)
		handler.ServeHTTP(httptest.NewRecorder(), request)

		if seen == sent || seen == "" {
			t.Errorf("%s: expected an id of our own, got %q", name, seen)
		}
	}
}

// Outside a request there is no id, and nothing pretends otherwise.
func TestRequestID_IsEmptyWithoutOne(t *testing.T) {
	if id := httputil.RequestID(context.Background()); id != "" {
		t.Errorf("id = %q, want empty", id)
	}
	attrs := httputil.LogAttrs(context.Background(), "circleId", "circle-1")
	if len(attrs) != 2 {
		t.Errorf("attrs = %v, want only what was passed", attrs)
	}
}
