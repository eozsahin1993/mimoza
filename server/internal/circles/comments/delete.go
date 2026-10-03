package comments

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type DeleteHandler struct {
	Service *Service
}

func (h *DeleteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	post, err := h.Service.Delete(r.Context(), r.PathValue("circleId"), r.PathValue("postId"),
		r.PathValue("commentId"), auth.AccountID(r.Context()))
	if err != nil {
		circles.WriteError(r.Context(), w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, circles.FromEntry(post))
}
