package circle

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
)

type DeleteHandler struct {
	Service *Service
}

func (h *DeleteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	err := h.Service.Delete(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()))
	if err != nil {
		circles.WriteError(r.Context(), w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// blobPrefix ends in a slash: without it the sweep also matches a circle
// whose id starts with the same characters.
func blobPrefix(circleID string) string { return circleID + "/" }
