package reactions

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type ClearHandler struct {
	Service *Service
}

func (h *ClearHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	post, err := h.Service.Clear(r.Context(), r.PathValue("circleId"), r.PathValue("postId"),
		auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, circles.FromEntry(post))
}
