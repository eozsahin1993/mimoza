package blobs

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// uploadResponse is a presigned POST: the form to send the bytes to, and
// the fields S3 will check them against.
type uploadResponse struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

type UploadHandler struct{ Service *Service }

func (h *UploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	target, err := h.Service.UploadTarget(r.Context(), r.PathValue("circleId"),
		r.PathValue("postId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, uploadResponse{URL: target.URL, Fields: target.Fields})
}

type CoverUploadHandler struct{ Service *Service }

func (h *CoverUploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	target, err := h.Service.CoverUploadTarget(r.Context(), r.PathValue("circleId"),
		r.PathValue("coverId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, uploadResponse{URL: target.URL, Fields: target.Fields})
}
