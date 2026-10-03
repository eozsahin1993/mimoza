package requests

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

type requestResponse struct {
	RequestID string `json:"requestId"`
	CircleID  string `json:"circleId"`
	AccountID string `json:"accountId"`
	// Name is who is asking: an admin answers a person, not an account
	// id. ProfilePictureID is absent when they have none; ProfilePictureURL
	// is a signed URL for the bytes, already resolved — see Service.List.
	Name              string `json:"name,omitempty"`
	ProfilePictureID  string `json:"profilePictureId,omitempty"`
	ProfilePictureURL string `json:"profilePictureUrl,omitempty"`
	// PublicKey is what an approving admin seals every content key
	// version to. Without it there is nothing to approve against: the
	// requester is not on the roster yet, so this is the only place
	// their key is published.
	PublicKey string `json:"publicKey,omitempty"`
	Status    string `json:"status"`
	CreatedAt int64  `json:"createdAt"`
}

func (h *CreateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	request, err := h.Service.Create(r.Context(), r.PathValue("code"), auth.AccountID(r.Context()))
	if err != nil {
		circles.WriteError(r.Context(), w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, asResponse(request))
}

func (h *ListHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requests, err := h.Service.List(r.Context(), r.PathValue("circleId"), auth.AccountID(r.Context()))
	if err != nil {
		circles.WriteError(r.Context(), w, err)
		return
	}

	body := listResponse{Requests: make([]requestResponse, 0, len(requests))}
	for _, request := range requests {
		row := asResponse(request.Request)
		row.Name = request.Name
		row.ProfilePictureID = request.ProfilePictureID
		row.ProfilePictureURL = request.ProfilePictureURL
		body.Requests = append(body.Requests, row)
	}
	httputil.WriteJSON(w, http.StatusOK, body)
}

func (h *ApproveHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body approveRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}

	sealed := make(circles.SealedKeys, len(body.Sealed))
	for version, encoded := range body.Sealed {
		parsed, err := strconv.ParseInt(version, 10, 64)
		if err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "sealed keys are keyed by version")
			return
		}
		key, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(key) == 0 {
			httputil.WriteError(w, http.StatusBadRequest, "sealed keys must be base64")
			return
		}
		sealed[parsed] = key
	}

	err := h.Service.Approve(r.Context(), r.PathValue("circleId"), r.PathValue("requestId"),
		auth.AccountID(r.Context()), sealed)
	if err != nil {
		circles.WriteError(r.Context(), w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *DenyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	err := h.Service.Deny(r.Context(), r.PathValue("circleId"), r.PathValue("requestId"),
		auth.AccountID(r.Context()))
	if err != nil {
		circles.WriteError(r.Context(), w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *CancelHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	err := h.Service.Cancel(r.Context(), r.PathValue("circleId"), r.PathValue("requestId"),
		auth.AccountID(r.Context()))
	if err != nil {
		circles.WriteError(r.Context(), w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func asResponse(request circles.Request) requestResponse {
	return requestResponse{
		RequestID: request.ID,
		CircleID:  request.CircleID,
		AccountID: request.AccountID,
		PublicKey: base64.StdEncoding.EncodeToString(request.PublicKey),
		Status:    request.Status,
		CreatedAt: request.CreatedAt.UnixMilli(),
	}
}
