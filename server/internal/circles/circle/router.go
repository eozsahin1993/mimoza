// Package circle is the slice for a circle itself: making one, renaming
// it or setting its cover, and deleting it. Reads of what is inside a
// circle belong to the other slices.
package circle

import (
	"net/http"
	"strings"
)

// Register mounts every route this resource answers. wrap, if non-nil,
// wraps each handler first — see internal/api for what they carry.
func Register(mux *http.ServeMux, service *Service, read, write func(http.Handler) http.Handler) {
	for pattern, handler := range map[string]http.Handler{
		"GET /circles":               &ListHandler{Service: service},
		"POST /circles":              &CreateHandler{Service: service},
		"PATCH /circles/{circleId}":  &PatchHandler{Service: service},
		"DELETE /circles/{circleId}": &DeleteHandler{Service: service},
		"POST /circles/{circleId}/blobs/cover/{coverId}/upload-target": &CoverUploadHandler{Service: service},
		"GET /circles/{circleId}/blobs/cover/{coverId}":                &CoverHandler{Service: service},
	} {
		wrap := write
		if strings.HasPrefix(pattern, "GET ") {
			wrap = read
		}
		if wrap != nil {
			handler = wrap(handler)
		}
		mux.Handle(pattern, handler)
	}
}
