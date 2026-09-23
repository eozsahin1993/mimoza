package httputil

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
)

// Header is what a client or a load balancer can set to tie its own
// trace to ours. Anything else is ignored: an id is only ever a label,
// so the only thing that matters is that it is short and printable.
const requestIDHeader = "X-Request-Id"

type requestIDKey struct{}

// WithRequestID gives every request an id and puts it on the context, so
// every line a handler logs can be tied to the call that produced it.
// Without one, two requests interleaving in the same log are impossible
// to tell apart.
func WithRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := sanitize(r.Header.Get(requestIDHeader))
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set(requestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

// RequestID is the id of the call being served, or "" outside one.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// LogAttrs is what every log line inside a request carries.
func LogAttrs(ctx context.Context, attrs ...any) []any {
	if id := RequestID(ctx); id != "" {
		return append([]any{"requestId", id}, attrs...)
	}
	return attrs
}

// Log writes one line with the request's id already on it.
func Log(ctx context.Context, level slog.Level, message string, attrs ...any) {
	slog.Log(ctx, level, message, LogAttrs(ctx, attrs...)...)
}

func newRequestID() string {
	buf := make([]byte, 8)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// sanitize keeps a caller's id only if it is short and printable ASCII:
// it ends up in logs, and a header is whatever someone sent.
func sanitize(id string) string {
	if len(id) == 0 || len(id) > 64 {
		return ""
	}
	for i := range len(id) {
		if id[i] < 0x21 || id[i] > 0x7e {
			return ""
		}
	}
	return id
}
