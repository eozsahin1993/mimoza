package reactions

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
	"mimoza-relay/internal/util/ids"
)

type ClearHandler struct {
	Service *Service
}

func (h *ClearHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	tag := r.PathValue("tag")
	if !ids.Valid(tag) {
		httputil.WriteError(w, http.StatusBadRequest, "tag must be a short id")
		return
	}

	post, err := h.Service.Remove(r.Context(), r.PathValue("circleId"), r.PathValue("postId"),
		auth.AccountID(r.Context()), tag)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, circles.FromEntry(post))
}
