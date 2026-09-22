package devices

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type DeleteHandler struct{ Service *Service }

func (h *DeleteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	err := h.Service.Delete(r.Context(), auth.AccountID(r.Context()), r.PathValue("deviceId"))
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "something went wrong")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
