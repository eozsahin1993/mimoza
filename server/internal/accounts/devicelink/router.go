// Package devicelink hands an account's keypair from a phone that has it
// to one that does not.
//
// The waiting phone opens a session with a throwaway public key and shows
// both in a QR code; the other phone scans it, seals the real keypair to
// that key and sends the blob; the waiting phone polls for it. Because
// the public key comes off the screen rather than from here, the relay is
// a dead drop — it never holds a key it could open the blob with, unlike
// the rewrap path, which does take its word for a member's public key.
package devicelink

import "net/http"

func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
		wrap    func(http.Handler) http.Handler
	}{
		// No account id in the path: the session says whose this is, and
		// that is also the access check (see dynamo.DeviceLinkKey).
		{"POST /account/device-link", &CreateHandler{Service: service}, write},
		{"POST /account/device-link/{sessionId}", &SendHandler{Service: service}, write},
		{"GET /account/device-link/{sessionId}", &GetHandler{Service: service}, read},
	}
	for _, route := range routes {
		handler := route.handler
		if route.wrap != nil {
			handler = route.wrap(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
