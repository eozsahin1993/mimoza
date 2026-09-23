// Package members is the slice for who is in a circle: the roster and
// the keys sealed to the caller, role and notification changes, removal,
// leaving, and resealing keys for a member who replaced their keypair.
package members

import "net/http"

func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
		wrap    func(http.Handler) http.Handler
	}{
		{"GET /circles/{circleId}/roster", &RosterHandler{Service: service}, read},
		{"PATCH /circles/{circleId}/members/{accountId}", &PatchHandler{Service: service}, write},
		{"POST /circles/{circleId}/members/{accountId}/remove", &RemoveHandler{Service: service}, write},
		{"POST /circles/{circleId}/leave", &LeaveHandler{Service: service}, write},
		{"POST /circles/{circleId}/keys", &RewrapHandler{Service: service}, write},
		{"POST /circles/{circleId}/blobs/avatar/{avatarId}/upload-target", &AvatarUploadHandler{Service: service}, write},
		{"GET /circles/{circleId}/blobs/avatar/{accountId}/{avatarId}", &AvatarHandler{Service: service}, read},
	}
	for _, route := range routes {
		handler := route.handler
		if route.wrap != nil {
			handler = route.wrap(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
