package invite

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"mimoza-relay/internal/invite"
	"mimoza-relay/internal/util/httputil"
)

type createInviteRequest struct {
	// InviteTag is sha256("invite-tag" || code), computed client-side.
	InviteTag string `json:"inviteTag"`
	// EncryptedPreview is base64-encoded ciphertext (the circle's current
	// name and a small cover-picture thumbnail, encrypted client-side with
	// HKDF(invite_code, "invite-preview")). This handler never looks
	// inside it.
	EncryptedPreview string `json:"encryptedPreview"`
}

type createInviteResponse struct {
	OK bool `json:"ok"`
}

type CreateInviteHandler struct {
	Service *Service
}

func (h *CreateInviteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req createInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	inviteTag := req.InviteTag
	if inviteTag == "" {
		httputil.WriteError(w, http.StatusBadRequest, "inviteTag is required")
		return
	}

	encryptedPreview, err := base64.StdEncoding.DecodeString(req.EncryptedPreview)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedPreview must be base64-encoded")
		return
	}
	if len(encryptedPreview) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "encryptedPreview is required")
		return
	}

	err = h.Service.CreateInvite(r.Context(), inviteTag, encryptedPreview)
	if errors.Is(err, invite.ErrInviteExists) {
		httputil.WriteError(w, http.StatusConflict, "invite already exists")
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to create invite")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, createInviteResponse{OK: true})
}

type getInviteResponse struct {
	EncryptedPreview string `json:"encryptedPreview"`
}

type GetInviteHandler struct {
	Service *Service
}

func (h *GetInviteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	inviteTag := r.PathValue("inviteTag")

	blob, err := h.Service.GetInvite(r.Context(), inviteTag)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to fetch invite")
		return
	}
	if blob == nil {
		httputil.WriteError(w, http.StatusNotFound, "invite not found")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, getInviteResponse{
		EncryptedPreview: base64.StdEncoding.EncodeToString(blob),
	})
}
