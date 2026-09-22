// Package requests is the slice for asking to join and being let in: the
// ask an invite code allows, the list an admin sees, and the approval
// that turns a request into a membership.
package requests

import "net/http"

func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
		wrap    func(http.Handler) http.Handler
	}{
		{"POST /invites/{code}/requests", &CreateHandler{Service: service}, write},
		{"GET /circles/{circleId}/requests", &ListHandler{Service: service}, read},
		{"POST /circles/{circleId}/requests/{requestId}/approve", &ApproveHandler{Service: service}, write},
		{"POST /circles/{circleId}/requests/{requestId}/deny", &DenyHandler{Service: service}, write},
	}
	for _, route := range routes {
		handler := route.handler
		if route.wrap != nil {
			handler = route.wrap(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
