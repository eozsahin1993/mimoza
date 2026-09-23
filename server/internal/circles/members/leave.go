package members

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type LeaveHandler struct {
	Service *Service
}

func (h *LeaveHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	expectedVersion, sealed, badRequest := decodeRotation(r)
	if badRequest != "" {
		httputil.WriteError(w, http.StatusBadRequest, badRequest)
		return
	}

	err := h.Service.Leave(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()), expectedVersion, sealed)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
