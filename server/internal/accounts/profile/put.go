package profile

import (
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type putRequest struct {
	Name string `json:"name"`
}

type PutHandler struct{ Service *Service }

func (h *PutHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body putRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if body.Name == "" {
		httputil.WriteError(w, http.StatusBadRequest, "name is required")
		return
	}

	profile, err := h.Service.Set(r.Context(), auth.AccountID(r.Context()), body.Name)
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, asResponse(profile))
}
