package comments

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// addRequest carries the client's own comment id, so a retry lands on
// the same comment rather than a second one, and an optional parent for
// replies, which nothing sends yet.
type addRequest struct {
	CommentID       string `json:"commentId"`
	ParentCommentID string `json:"parentCommentId"`
	KeyVersion      int64  `json:"keyVersion"`
	Ciphertext      string `json:"ciphertext"`
}

type AddHandler struct {
	Service *Service
}

func (h *AddHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body addRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if body.CommentID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "commentId is required")
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

	post, err := h.Service.Add(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()), circles.Comment{
		ID:              body.CommentID,
		PostID:          r.PathValue("postId"),
		ParentCommentID: body.ParentCommentID,
		KeyVersion:      body.KeyVersion,
		Ciphertext:      ciphertext,
	})
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, circles.FromEntry(post))
}
