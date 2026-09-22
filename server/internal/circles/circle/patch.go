package circle

import (
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type patchRequest struct {
	// Empty means "leave this alone", so setting a cover need not resend
	// the name and vice versa.
	Name    string `json:"name"`
	CoverID string `json:"coverId"`
}

type circleResponse struct {
	CircleID      string `json:"circleId"`
	Name          string `json:"name"`
	CoverID       string `json:"coverId,omitempty"`
	KeyVersion    int64  `json:"keyVersion"`
	RosterVersion int64  `json:"rosterVersion"`
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
	if body.Name == "" && body.CoverID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "name or coverId is required")
		return
	}

	circle, err := h.Service.Patch(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()), body.Name, body.CoverID)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, circleResponse{
		CircleID:      circle.ID,
		Name:          circle.Name,
		CoverID:       circle.CoverID,
		KeyVersion:    circle.KeyVersion,
		RosterVersion: circle.RosterVersion,
	})
}
