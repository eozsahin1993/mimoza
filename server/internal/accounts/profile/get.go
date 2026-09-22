package profile

import (
	"encoding/base64"
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
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, asResponse(profile))
}

// asResponse is shared with the put below: reading a profile back and
// writing one answer with the same body, so a device never has to ask
// twice.
func asResponse(profile accounts.Profile) profileResponse {
	return profileResponse{
		AccountID: profile.AccountID,
		Name:      profile.Name,
		AvatarKey: profile.AvatarKey,
		PublicKey: base64.StdEncoding.EncodeToString(profile.PublicKey),
		CreatedAt: profile.CreatedAt.UnixMilli(),
	}
}
