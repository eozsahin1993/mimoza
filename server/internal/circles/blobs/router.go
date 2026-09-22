// Package blobs is the slice for the encrypted bytes behind a post and a
// circle's cover. The relay never carries them: it hands a device a
// presigned URL and gets out of the way, so what it does here is decide
// who may upload and who may read.
package blobs

import "net/http"

func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
		wrap    func(http.Handler) http.Handler
	}{
		// The cover routes come first in spelling only; ServeMux prefers
		// the literal "cover" segment over the {postId} wildcard on its
		// own, whatever the registration order.
		{"POST /circles/{circleId}/blobs/cover/{coverId}/upload-target", &CoverUploadHandler{Service: service}, write},
		{"GET /circles/{circleId}/blobs/cover/{coverId}", &CoverDownloadHandler{Service: service}, read},
		{"POST /circles/{circleId}/blobs/{postId}/upload-target", &UploadHandler{Service: service}, write},
		{"GET /circles/{circleId}/blobs/{postId}", &DownloadHandler{Service: service}, read},
	}
	for _, route := range routes {
		handler := route.handler
		if route.wrap != nil {
			handler = route.wrap(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
