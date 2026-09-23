package members

import (
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
	"mimoza-relay/internal/util/ids"
)

// patchRequest carries whichever field is being set. Role is an admin's
// to change; notifyLevel and the picture are only ever your own — see
// Service.
type patchRequest struct {
	Role        string `json:"role"`
	NotifyLevel string `json:"notifyLevel"`
	AvatarID    string `json:"avatarId"`
	KeyVersion  int64  `json:"keyVersion"`
}

type PatchHandler struct {
	Service *Service
}

func (h *PatchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body patchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}

	circleID := r.PathValue("circleId")
	subjectID := r.PathValue("accountId")
	accountID := auth.AccountID(r.Context())

	switch {
	case body.Role != "":
		if body.Role != circles.RoleAdmin && body.Role != circles.RoleMember {
			httputil.WriteError(w, http.StatusBadRequest, "role must be admin or member")
			return
		}
		if err := h.Service.SetRole(r.Context(), circleID, subjectID, body.Role, accountID); err != nil {
			status, message := circles.Status(err)
			httputil.WriteError(w, status, message)
			return
		}
	case body.NotifyLevel != "":
		if !validLevel(body.NotifyLevel) {
			httputil.WriteError(w, http.StatusBadRequest, "notifyLevel must be all, comments, photos or none")
			return
		}
		if err := h.Service.SetNotifyLevel(r.Context(), circleID, subjectID, body.NotifyLevel, accountID); err != nil {
			status, message := circles.Status(err)
			httputil.WriteError(w, status, message)
			return
		}
	case body.AvatarID != "":
		if !ids.Valid(body.AvatarID) {
			httputil.WriteError(w, http.StatusBadRequest, "avatarId must be a short id, letters, digits, dot, dash or underscore")
			return
		}
		err := h.Service.SetAvatar(r.Context(), circleID, subjectID, accountID, body.AvatarID, body.KeyVersion)
		if err != nil {
			status, message := circles.Status(err)
			httputil.WriteError(w, status, message)
			return
		}
	default:
		httputil.WriteError(w, http.StatusBadRequest, "role, notifyLevel or avatarId is required")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validLevel(level string) bool {
	switch level {
	case circles.NotifyAll, circles.NotifyComments, circles.NotifyPhotos, circles.NotifyNone:
		return true
	}
	return false
}
