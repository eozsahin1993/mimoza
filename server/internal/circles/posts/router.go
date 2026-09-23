// Package posts is the slice for what a circle holds: writing a post,
// walking the entries, fetching one post's comments and reactions, and
// hiding or deleting a post.
package posts

import "net/http"

func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
		wrap    func(http.Handler) http.Handler
	}{
		{"POST /circles/{circleId}/entries", &PutHandler{Service: service}, write},
		{"POST /circles/{circleId}/blobs/{postId}/upload-target", &UploadHandler{Service: service}, write},
		{"GET /circles/{circleId}/blobs/{postId}", &PhotoHandler{Service: service}, read},
		{"GET /circles/{circleId}/entries", &WalkHandler{Service: service}, read},
		{"GET /circles/{circleId}/entries/{postId}/children", &ChildrenHandler{Service: service}, read},
		{"PATCH /circles/{circleId}/entries/{postId}", &PatchHandler{Service: service}, write},
		{"DELETE /circles/{circleId}/entries/{postId}", &DeleteHandler{Service: service}, write},
	}
	for _, route := range routes {
		handler := route.handler
		if route.wrap != nil {
			handler = route.wrap(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
