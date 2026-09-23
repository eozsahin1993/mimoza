// Package reactions is the slice for a member's reactions to a post.
// A member may hold several at once, so a reaction is a row per emoji:
// adding one is idempotent, and taking one back names its tag.
package reactions

import "net/http"

func Register(mux *http.ServeMux, service *Service, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
	}{
		{"PUT /circles/{circleId}/entries/{postId}/reactions/me", &SetHandler{Service: service}},
		{"DELETE /circles/{circleId}/entries/{postId}/reactions/{tag}", &ClearHandler{Service: service}},
	}
	for _, route := range routes {
		handler := route.handler
		if write != nil {
			handler = write(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
