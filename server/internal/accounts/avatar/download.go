package avatar

import (
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/util/httputil"
	"mimoza-relay/internal/util/ids"
)

type downloadResponse struct {
	URL string `json:"url"`
}

type DownloadHandler struct{ Service *Service }

func (h *DownloadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	accountID, avatarID := r.PathValue("accountId"), r.PathValue("avatarId")
	if !ids.Valid(accountID) || !ids.Valid(avatarID) {
		httputil.WriteError(w, http.StatusBadRequest, "that is not an avatar")
		return
	}

	url, err := h.Service.DownloadURL(r.Context(), accountID, avatarID)
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, downloadResponse{URL: url})
}
