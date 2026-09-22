package posts

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type childrenResponse struct {
	Comments  []circles.CommentView  `json:"comments"`
	Reactions []circles.ReactionView `json:"reactions"`
}

type ChildrenHandler struct {
	Service *Service
}

func (h *ChildrenHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	comments, reactions, err := h.Service.Children(r.Context(), r.PathValue("circleId"),
		r.PathValue("postId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	body := childrenResponse{
		Comments:  make([]circles.CommentView, 0, len(comments)),
		Reactions: make([]circles.ReactionView, 0, len(reactions)),
	}
	for _, comment := range comments {
		body.Comments = append(body.Comments, circles.FromComment(comment))
	}
	for _, reaction := range reactions {
		body.Reactions = append(body.Reactions, circles.FromReaction(reaction))
	}
	httputil.WriteJSON(w, http.StatusOK, body)
}
