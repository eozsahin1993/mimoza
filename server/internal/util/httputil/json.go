// Package httputil holds tiny cross-cutting HTTP plumbing shared across
// endpoint packages — response writing, not business logic. Same category
// as internal/ports/adapters: a shared misc component, not a "domain".
package httputil

import (
	"encoding/json"
	"net/http"
	"strings"
)

func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]string{"error": message})
}

// WriteCodedError is WriteError with a stable machine-readable code
// beside the message, for a client that has to act on which error it was.
func WriteCodedError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, map[string]string{"error": message, "code": code})
}

// BearerToken extracts the token from an "Authorization: Bearer <token>" header.
func BearerToken(r *http.Request) (string, bool) {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimPrefix(header, prefix)
	if token == "" {
		return "", false
	}
	return token, true
}
