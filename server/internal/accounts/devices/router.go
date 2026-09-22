// Package devices is the slice for the phones an account is signed in
// on. Push reaches these and nothing else, so registering one is what
// turns notifications on for that phone, and deleting it is what signing
// out does.
package devices

import "net/http"

func Register(mux *http.ServeMux, service *Service, write func(http.Handler) http.Handler) {
	routes := []struct {
		pattern string
		handler http.Handler
	}{
		{"PUT /account/devices/{deviceId}", &PutHandler{Service: service}},
		{"DELETE /account/devices/{deviceId}", &DeleteHandler{Service: service}},
	}
	for _, route := range routes {
		handler := route.handler
		if write != nil {
			handler = write(handler)
		}
		mux.Handle(route.pattern, handler)
	}
}
