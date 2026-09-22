// Package deletion is the slice for DELETE /account, the last relay call
// an account ever makes: the profile, the devices, the sign-ins that
// resolve to it, the Sign in with Apple grant behind one of them, and
// every session it left open.
package deletion

import "net/http"

func Register(mux *http.ServeMux, service *Service, wrap func(http.Handler) http.Handler) {
	// The exact "/account" pattern (no trailing slash) can't live inside
	// the "/account/" subtree sub-mux — ServeMux answers the bare path
	// there with a redirect, which DELETE callers won't follow — so this
	// registers on the parent mux and wraps its own session check.
	var handler http.Handler = &DeleteHandler{Service: service}
	if wrap != nil {
		handler = wrap(handler)
	}
	mux.Handle("DELETE /account", handler)
}
