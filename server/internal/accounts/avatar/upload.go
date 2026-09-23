package avatar

import (
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
	"mimoza-relay/internal/util/ids"
)

// uploadResponse is a presigned POST: the form to send the bytes to, and
// the fields S3 will check them against.
type uploadResponse struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

type UploadHandler struct{ Service *Service }

func (h *UploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	avatarID := r.PathValue("avatarId")
	if !ids.Valid(avatarID) {
		httputil.WriteError(w, http.StatusBadRequest, "avatarId must be a short id, letters, digits, dot, dash or underscore")
		return
	}

	target, err := h.Service.UploadTarget(r.Context(), auth.AccountID(r.Context()), avatarID)
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, uploadResponse{URL: target.URL, Fields: target.Fields})
}
