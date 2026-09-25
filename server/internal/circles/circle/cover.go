package circle

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
	"mimoza-relay/internal/util/ids"
)

// coverKey carries the client's content hash, so a new cover is a new
// key rather than an overwrite and the edge may cache forever.
func coverKey(circleID, coverID string) string { return circleID + "/cover/" + coverID }

// maxCoverSize matches a post's photo: a cover is one.
const maxCoverSize = 5 * 1024 * 1024

type uploadResponse struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

type coverResponse struct {
	URL string `json:"url"`
}

type CoverUploadHandler struct{ Service *Service }

func (h *CoverUploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	coverID := r.PathValue("coverId")
	if !ids.Valid(coverID) {
		httputil.WriteError(w, http.StatusBadRequest, "coverId must be a short id, letters, digits, dot, dash or underscore")
		return
	}

	target, err := h.Service.CoverUploadTarget(r.Context(), r.PathValue("circleId"), coverID, auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, uploadResponse{URL: target.URL, Fields: target.Fields})
}

type CoverHandler struct{ Service *Service }

func (h *CoverHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	url, err := h.Service.CoverURL(r.Context(), r.PathValue("circleId"),
		r.PathValue("coverId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, coverResponse{URL: url})
}
