package getepochs

import "net/http"

// Register mounts this endpoint's route onto mux — called by the final,
// aggregating router in internal/app. wrap, if non-nil, wraps the handler
// before registration (e.g. ratelimit.Require).
func Register(mux *http.ServeMux, service *Service, wrap func(http.Handler) http.Handler) {
	var h http.Handler = &Handler{Service: service}
	if wrap != nil {
		h = wrap(h)
	}
	mux.Handle("POST /epochs/peek", h)
}
