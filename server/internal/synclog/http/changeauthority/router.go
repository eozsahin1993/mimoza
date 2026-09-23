package changeauthority

import "net/http"

// Register mounts this endpoint's route onto mux — called by the final,
// aggregating router in internal/app, which decides what version prefix
// (if any) mux itself is mounted under. wrap, if non-nil, wraps the handler
// before registration (e.g. ratelimit.Require) — lets read and write
// endpoints carry different middleware despite sharing one sub-mux.
func Register(mux *http.ServeMux, service *Service, wrap func(http.Handler) http.Handler) {
	var h http.Handler = &Handler{Service: service}
	if wrap != nil {
		h = wrap(h)
	}
	mux.Handle("POST /circles/{syncId}/authority", h)
}
