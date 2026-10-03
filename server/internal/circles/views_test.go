package circles

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"mimoza-relay/internal/util/httputil"
)

func TestWriteError(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{"stale key, wrapped", fmt.Errorf("put: %w", ErrStaleKeyVersion), http.StatusConflict, "stale_key_version"},
		{"not a member", ErrNotMember, http.StatusForbidden, "not_member"},
		{"unmapped", errors.New("boom"), http.StatusInternalServerError, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))

			rec := httptest.NewRecorder()
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				WriteError(r.Context(), w, tt.err)
			})
			httputil.LogRequests(handler).ServeHTTP(rec, httptest.NewRequest("POST", "/x", nil))

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			var body map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
			}
			if body["code"] != tt.wantCode {
				t.Errorf("code = %q, want %q", body["code"], tt.wantCode)
			}
			if body["error"] == "" {
				t.Error("body has no error message")
			}

			// The message the client got is also what the request line says.
			var logged struct {
				Reason string `json:"reason"`
			}
			if err := json.Unmarshal(lastLine(buf.Bytes()), &logged); err != nil {
				t.Fatalf("request line is not JSON: %v (%q)", err, buf.String())
			}
			if logged.Reason != body["error"] {
				t.Errorf("reason = %q, body error = %q", logged.Reason, body["error"])
			}
		})
	}
}

// Status logs an unmapped error itself before the request line, so the
// request line is whichever came last.
func lastLine(b []byte) []byte {
	lines := bytes.Split(bytes.TrimSpace(b), []byte("\n"))
	return lines[len(lines)-1]
}
