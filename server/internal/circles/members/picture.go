package members

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type pictureResponse struct {
	URL string `json:"url"`
}

// PictureHandler signs a member's profile picture for another member.
// The picture is the account's (see accounts/profile); the circle in the
// path is what says the caller is allowed to see it.
type PictureHandler struct{ Service *Service }

func (h *PictureHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	url, err := h.Service.ProfilePictureURL(r.Context(), r.PathValue("circleId"),
		r.PathValue("accountId"), r.PathValue("pictureId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, pictureResponse{URL: url})
}
