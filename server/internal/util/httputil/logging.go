package httputil

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// LogRequests records one line per request: what was called, how it went,
// and how long it took.
//
// The route pattern, never the path — a path carries syncIds, invite tags
// and push routing ids, and a log is a place they would sit correlatable
// for as long as retention allows. The relay is meant not to know who is
// talking to whom, and its own logs shouldn't undo that.
func LogRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		matched := &matchedRoute{}
		r = r.WithContext(context.WithValue(r.Context(), routeKey{}, matched))

		next.ServeHTTP(recorder, r)

		slog.InfoContext(r.Context(), "request", LogAttrs(r.Context(),
			"method", r.Method,
			"route", route(r, matched),
			"status", recorder.status,
			"ms", time.Since(started).Milliseconds())...)
	})
}

// LogRoutes makes LogRequests name the endpoint a nested mux matched,
// rather than the group it is mounted under.
//
// Middleware between the two muxes copies the request (RequireSession adds
// the session to its context), and the inner mux then records its pattern
// on that copy — so without this, everything under a mount logs as
// "/circles/". Handler reports the match without performing it.
//
// It resolves one level. A mux nested inside a mux needs this at each
// mount, or the deeper pattern is the one that goes missing.
func LogRoutes(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); pattern != "" {
			if matched, ok := r.Context().Value(routeKey{}).(*matchedRoute); ok {
				matched.pattern = pattern
			}
		}
		mux.ServeHTTP(w, r)
	})
}

type routeKey struct{}

type matchedRoute struct{ pattern string }

// A request nothing matched has no pattern anywhere, which is worth seeing
// as itself: a client calling a route that doesn't exist.
func route(r *http.Request, matched *matchedRoute) string {
	switch {
	case matched.pattern != "":
		return matched.pattern
	case r.Pattern != "":
		return r.Pattern
	default:
		return "(no route)"
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}
