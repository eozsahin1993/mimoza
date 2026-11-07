package devsession

import "net/http"

// Register mounts the route on mux at the root, outside /v1, so nothing
// that aggregates the real API can pick it up by accident. Only
// cmd/testrelay and cmd/server (behind DEV_SESSIONS) call this; the Lambda
// never does.
func Register(mux *http.ServeMux, service *Service) {
	mux.Handle("POST /testonly/session", &Handler{Service: service})
}
