// Package comments is the slice for a post's comments: adding one, and
// taking one back. Reading them belongs to the posts slice, which serves
// a post's children in one call.
package comments

import "net/http"

func Register(mux *http.ServeMux, service *Service, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
	}{
		{"POST /circles/{circleId}/entries/{postId}/comments", &AddHandler{Service: service}},
		{"DELETE /circles/{circleId}/entries/{postId}/comments/{commentId}", &DeleteHandler{Service: service}},
	}
	for _, route := range routes {
		handler := route.handler
		if write != nil {
			handler = write(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
