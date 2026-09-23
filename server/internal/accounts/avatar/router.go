// Package avatar is the picture on an account. Uploading is your own, so
// no account id appears in the path; reading anyone's is not, since a
// roster exists to be rendered.
package avatar

import "net/http"

func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
		wrap    func(http.Handler) http.Handler
	}{
		{"POST /account/avatar/{avatarId}/upload-target", &UploadHandler{Service: service}, write},
		{"GET /avatars/{accountId}/{avatarId}", &DownloadHandler{Service: service}, read},
	}
	for _, route := range routes {
		handler := route.handler
		if route.wrap != nil {
			handler = route.wrap(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
