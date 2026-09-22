package members

import (
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// rewrapRequest is one member handing another the content keys again,
// sealed to the public key that member now has.
type rewrapRequest struct {
	AccountID string            `json:"accountId"`
	Sealed    map[string]string `json:"sealed"`
}

type RewrapHandler struct {
	Service *Service
}

func (h *RewrapHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body rewrapRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if body.AccountID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "accountId is required")
		return
	}
	sealed, err := sealedFrom(body.Sealed)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "sealed must be a map of version to base64")
		return
	}

	err = h.Service.Rewrap(r.Context(), r.PathValue("circleId"), body.AccountID, auth.AccountID(r.Context()), sealed)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
