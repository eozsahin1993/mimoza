package profile

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type publicKeyRequest struct {
	PublicKey string `json:"publicKey"`
	// Reset says this device has no private key and made a new pair, so
	// every content key sealed to the old one has to be resealed.
	Reset bool `json:"reset"`
}

type publicKeyResponse struct {
	// AwaitingRewrap is the circles whose keys are now unreadable until
	// another member reseals them — what a device shows as waiting.
	AwaitingRewrap []string `json:"awaitingRewrap,omitempty"`
}

type PublicKeyHandler struct{ Service *Service }

func (h *PublicKeyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body publicKeyRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	publicKey, err := base64.StdEncoding.DecodeString(body.PublicKey)
	if err != nil || len(publicKey) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "publicKey must be base64")
		return
	}

	waiting, err := h.Service.SetPublicKey(r.Context(), auth.AccountID(r.Context()), publicKey, body.Reset)
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, publicKeyResponse{AwaitingRewrap: waiting})
}
