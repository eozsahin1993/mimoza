package reactions

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// setRequest carries the tag the relay counts by and the ciphertext it
// never opens. The ciphertext holds the emoji today, and whatever a
// reaction grows into later.
type setRequest struct {
	Tag        string `json:"tag"`
	KeyVersion int64  `json:"keyVersion"`
	Ciphertext string `json:"ciphertext"`
}

type SetHandler struct {
	Service *Service
}

func (h *SetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body setRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if body.Tag == "" {
		httputil.WriteError(w, http.StatusBadRequest, "tag is required")
		return
	}
	if body.KeyVersion <= 0 {
		httputil.WriteError(w, http.StatusBadRequest, "keyVersion is required")
		return
	}
	ciphertext, err := base64.StdEncoding.DecodeString(body.Ciphertext)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "ciphertext must be base64")
		return
	}

	post, err := h.Service.Set(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()), circles.Reaction{
		PostID:     r.PathValue("postId"),
		Tag:        body.Tag,
		KeyVersion: body.KeyVersion,
		Ciphertext: ciphertext,
	})
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, circles.FromEntry(post))
}
