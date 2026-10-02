package profile

import (
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
	"mimoza-relay/internal/util/ids"
)

type uploadResponse struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

type pictureRequest struct {
	PictureID string `json:"pictureId"`
}

const badPictureID = "pictureId must be a short id, letters, digits, dot, dash or underscore"

// PictureUploadHandler hands out somewhere to put the bytes. The id is
// the caller's, minted fresh per picture, and becomes part of the key.
type PictureUploadHandler struct{ Service *Service }

func (h *PictureUploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	pictureID := r.PathValue("pictureId")
	if !ids.Valid(pictureID) {
		httputil.WriteError(w, http.StatusBadRequest, badPictureID)
		return
	}
	target, err := h.Service.PictureUploadTarget(r.Context(), auth.AccountID(r.Context()), pictureID)
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, uploadResponse{URL: target.URL, Fields: target.Fields})
}

// SetPictureHandler says which uploaded picture is now the account's.
type SetPictureHandler struct{ Service *Service }

func (h *SetPictureHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body pictureRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if !ids.Valid(body.PictureID) {
		httputil.WriteError(w, http.StatusBadRequest, badPictureID)
		return
	}
	profile, err := h.Service.SetPicture(r.Context(), auth.AccountID(r.Context()), body.PictureID)
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, asResponse(profile))
}

// ClearPictureHandler takes the picture away again.
type ClearPictureHandler struct{ Service *Service }

func (h *ClearPictureHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	profile, err := h.Service.SetPicture(r.Context(), auth.AccountID(r.Context()), "")
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, asResponse(profile))
}
