package posts

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
	"mimoza-relay/internal/util/ids"
)

// photoKey is written once and never overwritten, so the edge may cache
// it forever.
func photoKey(circleID, postID string) string { return circleID + "/" + postID }

// maxPhotoSize bounds what a client that skips compression can store.
const maxPhotoSize = 2 * 1024 * 1024

type uploadResponse struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

type photoResponse struct {
	URL string `json:"url"`
}

type UploadHandler struct{ Service *Service }

func (h *UploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	postID := r.PathValue("postId")
	if !ids.Valid(postID) {
		httputil.WriteError(w, http.StatusBadRequest, "postId must be a short id, letters, digits, dot, dash or underscore")
		return
	}

	target, err := h.Service.UploadTarget(r.Context(), r.PathValue("circleId"), postID, auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, uploadResponse{URL: target.URL, Fields: target.Fields})
}

type PhotoHandler struct{ Service *Service }

func (h *PhotoHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	url, err := h.Service.PhotoURL(r.Context(), r.PathValue("circleId"),
		r.PathValue("postId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, photoResponse{URL: url})
}
