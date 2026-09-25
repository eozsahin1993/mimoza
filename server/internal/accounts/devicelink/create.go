package devicelink

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type createRequest struct {
	// Throwaway, so a session left lying around reveals nothing.
	PublicKey string `json:"publicKey"`
}

type createResponse struct {
	SessionID string `json:"sessionId"`
	ExpiresAt int64  `json:"expiresAt"`
}

type CreateHandler struct{ Service *Service }

func (h *CreateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body createRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	publicKey, err := base64.StdEncoding.DecodeString(body.PublicKey)
	if err != nil || len(publicKey) != accounts.X25519KeyLength {
		httputil.WriteError(w, http.StatusBadRequest, "publicKey must be a base64 X25519 key")
		return
	}

	link, err := h.Service.Create(r.Context(), auth.AccountID(r.Context()), publicKey)
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, createResponse{
		SessionID: link.SessionID,
		ExpiresAt: link.ExpiresAt.UnixMilli(),
	})
}
