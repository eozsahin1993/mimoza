package posts

import (
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type patchRequest struct {
	Visibility string `json:"visibility"`
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
	if body.Visibility == "" {
		httputil.WriteError(w, http.StatusBadRequest, "visibility is required")
		return
	}

	entry, err := h.Service.SetVisibility(r.Context(), r.PathValue("circleId"), r.PathValue("postId"),
		auth.AccountID(r.Context()), body.Visibility)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, circles.FromEntry(entry))
}
