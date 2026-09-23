package logout

import "net/http"

// Register mounts this endpoint's route onto mux — called by the final,
// aggregating router in internal/app, which decides what version prefix
// (if any) mux itself is mounted under.
func Register(mux *http.ServeMux, service *Service) {
	mux.Handle("POST /auth/logout", &Handler{Service: service})
}
