package deletion

import (
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type response struct {
	OK bool `json:"ok"`
}

type DeleteHandler struct {
	Service *Service
}

func (h *DeleteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.Delete(r.Context(), auth.AccountID(r.Context())); err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, response{OK: true})
}
