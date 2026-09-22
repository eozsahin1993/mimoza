package circle

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
	err := h.Service.Delete(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
