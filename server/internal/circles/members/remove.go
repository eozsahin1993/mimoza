package members

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// removeRequest carries the next content key, sealed once per remaining
// member. expectedVersion is the version those seals were made against:
// if another admin rotated first, this request is stale and is refused
// rather than installing a key half the circle cannot open.
type removeRequest struct {
	ExpectedVersion int64             `json:"expectedVersion"`
	Sealed          map[string]string `json:"sealed"`
}

type RemoveHandler struct {
	Service *Service
}

func (h *RemoveHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body removeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if body.ExpectedVersion <= 0 {
		httputil.WriteError(w, http.StatusBadRequest, "expectedVersion is required")
		return
	}

	sealed := make(map[string][]byte, len(body.Sealed))
	for accountID, encoded := range body.Sealed {
		key, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "sealed keys must be base64")
			return
		}
		sealed[accountID] = key
	}

	err := h.Service.Remove(r.Context(), r.PathValue("circleId"), r.PathValue("accountId"),
		auth.AccountID(r.Context()), body.ExpectedVersion, sealed)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
