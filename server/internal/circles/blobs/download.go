package blobs

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// downloadResponse is a URL the device fetches directly, from the CDN
// where there is one and from S3 where there is not. It is short-lived,
// and handing one out costs no call to either.
type downloadResponse struct {
	URL string `json:"url"`
}

type DownloadHandler struct{ Service *Service }

func (h *DownloadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	url, err := h.Service.DownloadURL(r.Context(), r.PathValue("circleId"),
		r.PathValue("postId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, downloadResponse{URL: url})
}

type CoverDownloadHandler struct{ Service *Service }

func (h *CoverDownloadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	url, err := h.Service.CoverDownloadURL(r.Context(), r.PathValue("circleId"),
		r.PathValue("coverId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, downloadResponse{URL: url})
}
