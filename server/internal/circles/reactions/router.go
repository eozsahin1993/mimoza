// Package reactions is the slice for a member's own reaction to a post.
// One slot per member per post, addressed as "mine": setting it replaces
// whatever was there, and clearing it takes it back.
package reactions

import "net/http"

func Register(mux *http.ServeMux, service *Service, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
	}{
		{"PUT /circles/{circleId}/entries/{postId}/reactions/me", &SetHandler{Service: service}},
		{"DELETE /circles/{circleId}/entries/{postId}/reactions/me", &ClearHandler{Service: service}},
	}
	for _, route := range routes {
		handler := route.handler
		if write != nil {
			handler = write(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
