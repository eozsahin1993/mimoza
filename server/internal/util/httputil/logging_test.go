package httputil

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLogRequestsRoute(t *testing.T) {
	inner := http.NewServeMux()
	inner.HandleFunc("POST /circles/{syncId}/entries", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	mux := http.NewServeMux()
	mux.Handle("POST /auth/apple", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	// Wrapped the way router.go mounts a group, session check and all: the
	// nested mux gets its own copy of the request, so its pattern only
	// reaches the log through Subtree.
	mux.Handle("/circles/", passthrough(LogRoutes(inner)))

	tests := []struct {
		name   string
		method string
		target string
		want   string
	}{
		{"direct route", "POST", "/auth/apple", "POST /auth/apple"},
		{"nested route", "POST", "/circles/abc/entries", "POST /circles/{syncId}/entries"},
		{"nothing matched", "GET", "/nope", "(no route)"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))

			r := httptest.NewRequest(tt.method, tt.target, nil)
			LogRequests(mux).ServeHTTP(httptest.NewRecorder(), r)

			var logged struct {
				Route string `json:"route"`
			}
			if err := json.Unmarshal(buf.Bytes(), &logged); err != nil {
				t.Fatalf("log line is not JSON: %v (%q)", err, buf.String())
			}
			if logged.Route != tt.want {
				t.Errorf("route = %q, want %q", logged.Route, tt.want)
			}
		})
	}
}

// Stands in for auth.RequireSession, which hands the next handler a request
// carrying the caller's session — and so a copy of the one being logged.
func passthrough(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(r.Context()))
	})
}

func TestLogRequestsReason(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SetReason(r.Context(), "encrypted under an old key version")
		w.WriteHeader(http.StatusConflict)
	})

	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	LogRequests(handler).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/x", nil))

	var logged struct {
		Status int    `json:"status"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(buf.Bytes(), &logged); err != nil {
		t.Fatalf("log line is not JSON: %v (%q)", err, buf.String())
	}
	if logged.Status != http.StatusConflict || logged.Reason != "encrypted under an old key version" {
		t.Errorf("logged = %+v", logged)
	}

	// A request that set no reason logs no reason field at all.
	buf.Reset()
	LogRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).
		ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/y", nil))
	if bytes.Contains(buf.Bytes(), []byte(`"reason"`)) {
		t.Errorf("reason logged without being set: %s", buf.String())
	}
}
