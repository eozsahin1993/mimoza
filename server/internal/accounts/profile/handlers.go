package profile

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type profileResponse struct {
	AccountID string `json:"accountId"`
	Name      string `json:"name"`
	AvatarKey string `json:"avatarKey,omitempty"`
	// PublicKey is what other members seal this account's content keys
	// to. Empty until a device publishes one.
	PublicKey string `json:"publicKey,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

type GetHandler struct{ Service *Service }

func (h *GetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	profile, err := h.Service.Get(r.Context(), auth.AccountID(r.Context()))
	if err != nil {
		writeError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, asResponse(profile))
}

type putRequest struct {
	Name      string `json:"name"`
	AvatarKey string `json:"avatarKey"`
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

	profile, err := h.Service.Set(r.Context(), auth.AccountID(r.Context()), body.Name, body.AvatarKey)
	if err != nil {
		writeError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, asResponse(profile))
}

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
		writeError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, publicKeyResponse{AwaitingRewrap: waiting})
}

func asResponse(profile accounts.Profile) profileResponse {
	return profileResponse{
		AccountID: profile.AccountID,
		Name:      profile.Name,
		AvatarKey: profile.AvatarKey,
		PublicKey: base64.StdEncoding.EncodeToString(profile.PublicKey),
		CreatedAt: profile.CreatedAt.UnixMilli(),
	}
}

// writeError keeps the mapping in one place: an account that is not
// there is the only failure a caller can do anything about.
func writeError(w http.ResponseWriter, err error) {
	if errors.Is(err, accounts.ErrNotFound) {
		httputil.WriteError(w, http.StatusNotFound, err.Error())
		return
	}
	httputil.WriteError(w, http.StatusInternalServerError, "something went wrong")
}
