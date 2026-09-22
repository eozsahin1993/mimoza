package circle

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type createRequest struct {
	Name string `json:"name"`
	// SealedKey is the first content key, sealed to the founder's own
	// account public key. Without it they would create a circle they
	// could not read.
	SealedKey string `json:"sealedKey"`
}

type createResponse struct {
	CircleID      string `json:"circleId"`
	KeyVersion    int64  `json:"keyVersion"`
	RosterVersion int64  `json:"rosterVersion"`
}

type CreateHandler struct {
	Service *Service
}

func (h *CreateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body createRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if body.Name == "" {
		httputil.WriteError(w, http.StatusBadRequest, "name is required")
		return
	}
	sealed, err := base64.StdEncoding.DecodeString(body.SealedKey)
	if err != nil || len(sealed) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "sealedKey must be base64")
		return
	}

	circle, err := h.Service.Create(r.Context(), auth.AccountID(r.Context()), body.Name, sealed)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, createResponse{
		CircleID:      circle.ID,
		KeyVersion:    circle.KeyVersion,
		RosterVersion: circle.RosterVersion,
	})
}
