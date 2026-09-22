// Package invites is the slice for the codes an admin hands out: making
// one, listing the live ones, revoking one, and the preview anyone with
// a code can read before deciding to ask.
package invites

import "net/http"

func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
		wrap    func(http.Handler) http.Handler
	}{
		{"POST /circles/{circleId}/invites", &CreateHandler{Service: service}, write},
		{"GET /circles/{circleId}/invites", &ListHandler{Service: service}, read},
		{"DELETE /circles/{circleId}/invites/{code}", &RevokeHandler{Service: service}, write},
		// Readable by anyone signed in: they hold the code, and the
		// answer is what the link already promised them.
		{"GET /invites/{code}", &PreviewHandler{Service: service}, read},
	}
	for _, route := range routes {
		handler := route.handler
		if route.wrap != nil {
			handler = route.wrap(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
