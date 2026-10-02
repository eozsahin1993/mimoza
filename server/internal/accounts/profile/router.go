// Package profile is the slice for the account itself: what other
// members see, the picture beside it, and the public key they seal
// content keys to.
package profile

import "net/http"

func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
		wrap    func(http.Handler) http.Handler
	}{
		// No account id in the path: the session says whose this is, and
		// it is the only one a caller may read or change.
		{"GET /account", &GetHandler{Service: service}, read},
		{"PUT /account/profile", &PutHandler{Service: service}, write},
		{"PUT /account/pubkey", &PublicKeyHandler{Service: service}, write},
		{"POST /account/picture/{pictureId}/upload-target", &PictureUploadHandler{Service: service}, write},
		{"PUT /account/picture", &SetPictureHandler{Service: service}, write},
		{"DELETE /account/picture", &ClearPictureHandler{Service: service}, write},
	}
	for _, route := range routes {
		handler := route.handler
		if route.wrap != nil {
			handler = route.wrap(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
