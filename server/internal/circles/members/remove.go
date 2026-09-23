package members

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type RemoveHandler struct {
	Service *Service
}

func (h *RemoveHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	expectedVersion, sealed, badRequest := decodeRotation(r)
	if badRequest != "" {
		httputil.WriteError(w, http.StatusBadRequest, badRequest)
		return
	}

	err := h.Service.Remove(r.Context(), r.PathValue("circleId"), r.PathValue("accountId"),
		auth.AccountID(r.Context()), expectedVersion, sealed)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
