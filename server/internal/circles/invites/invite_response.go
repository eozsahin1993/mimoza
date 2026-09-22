package invites

import (
	"net/http"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type inviteResponse struct {
	Code      string `json:"code"`
	CreatedBy string `json:"createdBy"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

func (h *CreateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	invite, err := h.Service.Create(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, asResponse(invite))
}

func (h *ListHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	invites, err := h.Service.List(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	body := listResponse{Invites: make([]inviteResponse, 0, len(invites))}
	for _, invite := range invites {
		body.Invites = append(body.Invites, asResponse(invite))
	}
	httputil.WriteJSON(w, http.StatusOK, body)
}

func (h *RevokeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	err := h.Service.Revoke(r.Context(), r.PathValue("circleId"), r.PathValue("code"), auth.AccountID(r.Context()))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *PreviewHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	preview, err := h.Service.Preview(r.Context(), r.PathValue("code"))
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, previewResponse{
		CircleID:    preview.CircleID,
		Name:        preview.Name,
		MemberCount: preview.MemberCount,
		InvitedBy:   preview.InvitedBy,
	})
}

func asResponse(invite circles.Invite) inviteResponse {
	return inviteResponse{
		Code:      invite.Code,
		CreatedBy: invite.CreatedBy,
		CreatedAt: invite.CreatedAt.UnixMilli(),
		ExpiresAt: invite.ExpiresAt.UnixMilli(),
	}
}
