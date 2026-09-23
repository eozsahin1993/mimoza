package members

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
	"mimoza-relay/internal/util/ids"
)

// avatarKey is a member's picture in one circle. It sits under the
// circle's prefix so deleting the circle sweeps it, and it carries the
// account so a member can only ever write their own.
func avatarKey(circleID, accountID, avatarID string) string {
	return circleID + "/avatar/" + accountID + "/" + avatarID
}

// maxAvatarSize caps one picture, far below what a photo is allowed.
const maxAvatarSize = 512 * 1024

type uploadResponse struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

type avatarResponse struct {
	URL string `json:"url"`
}

type AvatarUploadHandler struct{ Service *Service }

func (h *AvatarUploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	avatarID := r.PathValue("avatarId")
	if !ids.Valid(avatarID) {
		httputil.WriteError(w, http.StatusBadRequest, "avatarId must be a short id, letters, digits, dot, dash or underscore")
		return
	}

	target, err := h.Service.AvatarUploadTarget(r.Context(), r.PathValue("circleId"),
		auth.AccountID(r.Context()), avatarID)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, uploadResponse{URL: target.URL, Fields: target.Fields})
}

type AvatarHandler struct{ Service *Service }

func (h *AvatarHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	url, err := h.Service.AvatarURL(r.Context(), r.PathValue("circleId"),
		r.PathValue("accountId"), r.PathValue("avatarId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, avatarResponse{URL: url})
}
