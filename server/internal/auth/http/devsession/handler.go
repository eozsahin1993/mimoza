package devsession

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"mimoza-relay/internal/util/httputil"
)

type request struct {
	// Subject stands in for what a provider would have verified.
	Subject string `json:"subject"`
	Token   string `json:"token"`
}

type response struct {
	AccountID string `json:"accountId"`
	Token     string `json:"token"`
}

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Subject == "" {
		httputil.WriteError(w, http.StatusBadRequest, "subject is required")
		return
	}

	accountID, token, err := h.Service.SignIn(r.Context(), req.Subject, req.Token)
	if err != nil {
		slog.ErrorContext(r.Context(), "dev session failed", "error", err)
		httputil.WriteError(w, http.StatusInternalServerError, "could not sign in")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, response{AccountID: accountID, Token: token})
}
