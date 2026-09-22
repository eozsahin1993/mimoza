package posts

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// putRequest carries the client's own entry id, which is what makes a
// retry land on the same post rather than a second one.
type putRequest struct {
	EntryID    string `json:"entryId"`
	KeyVersion int64  `json:"keyVersion"`
	Ciphertext string `json:"ciphertext"`
	HasBlob    bool   `json:"hasBlob"`
	Visibility string `json:"visibility"`
}

type PutHandler struct {
	Service *Service
}

func (h *PutHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body putRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if body.EntryID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "entryId is required")
		return
	}
	if body.KeyVersion <= 0 {
		httputil.WriteError(w, http.StatusBadRequest, "keyVersion is required")
		return
	}
	ciphertext, err := base64.StdEncoding.DecodeString(body.Ciphertext)
	if err != nil || len(ciphertext) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "ciphertext must be base64")
		return
	}

	entry, err := h.Service.Put(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()), circles.Entry{
		ID:         body.EntryID,
		KeyVersion: body.KeyVersion,
		Ciphertext: ciphertext,
		HasBlob:    body.HasBlob,
		Visibility: body.Visibility,
	})
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, circles.FromEntry(entry))
}
