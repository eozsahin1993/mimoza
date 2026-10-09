// Package submit is the one thing the app does with feedback: send it.
// Reading it is a human's job, from the inbox the notifier writes to.
package submit

import "net/http"

func Register(mux *http.ServeMux, service *Service, write func(http.Handler) http.Handler) {
	var handler http.Handler = &Handler{Service: service}
	if write != nil {
		handler = write(handler)
	}
	mux.Handle("POST /feedback", handler)
}
