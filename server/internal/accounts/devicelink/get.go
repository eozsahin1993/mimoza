package devicelink

import (
	"encoding/base64"
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type linkResponse struct {
	SessionID string `json:"sessionId"`
	PublicKey string `json:"publicKey"`
	// Absent until the other device answers, which is what polling waits for.
	SealedKeypair string `json:"sealedKeypair,omitempty"`
	ExpiresAt     int64  `json:"expiresAt"`
}

type GetHandler struct{ Service *Service }

func (h *GetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	link, err := h.Service.Get(r.Context(), auth.AccountID(r.Context()), r.PathValue("sessionId"))
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	response := linkResponse{
		SessionID: link.SessionID,
		PublicKey: base64.StdEncoding.EncodeToString(link.PublicKey),
		ExpiresAt: link.ExpiresAt.UnixMilli(),
	}
	if link.Delivered() {
		response.SealedKeypair = base64.StdEncoding.EncodeToString(link.SealedKeypair)
	}
	httputil.WriteJSON(w, http.StatusOK, response)
}
