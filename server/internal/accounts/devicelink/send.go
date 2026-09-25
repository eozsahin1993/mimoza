package devicelink

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

// maxSealedKeypair is a sanity bound, not a format — the real payload is
// a couple of hundred bytes. It stops a session row becoming storage.
const maxSealedKeypair = 4096

type sendRequest struct {
	SealedKeypair string `json:"sealedKeypair"`
}

type SendHandler struct{ Service *Service }

func (h *SendHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body sendRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	sealed, err := base64.StdEncoding.DecodeString(body.SealedKeypair)
	if err != nil || len(sealed) == 0 || len(sealed) > maxSealedKeypair {
		httputil.WriteError(w, http.StatusBadRequest, "sealedKeypair must be base64")
		return
	}

	err = h.Service.Send(r.Context(), auth.AccountID(r.Context()), r.PathValue("sessionId"), sealed)
	if err != nil {
		status, message := accounts.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
