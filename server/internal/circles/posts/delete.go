package posts

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type DeleteHandler struct {
	Service *Service
}

// The row survives with its ciphertext stripped, so the deletion reaches
// every device through the same walk a post does.
func (h *DeleteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	entry, err := h.Service.Delete(r.Context(), r.PathValue("circleId"), r.PathValue("postId"),
		auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, circles.FromEntry(entry))
}
