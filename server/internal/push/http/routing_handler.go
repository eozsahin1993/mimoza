package push

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"mimoza-relay/internal/push"
	"mimoza-relay/internal/util/httputil"
)

// MaxPushTokenBytes leaves room for an FCM registration token plus AEAD
// overhead, while keeping the row from becoming somewhere to park data.
const MaxPushTokenBytes = 4096

type putPrefsRequest struct {
	// Base64 sha256(pushFanoutToken || pushRoutingId), computed client-side. The
	// relay never holds the token itself.
	PushFanoutHash string `json:"pushFanoutHash"`
	// A list, not the bitmask it becomes: encoding the mask client-side
	// would pin the storage format into the wire contract.
	Categories []int64 `json:"categories"`
	KeyVersion int64   `json:"keyVersion"`
}

// packCategories folds the wire list into the mask the store keeps.
func packCategories(categories []int64) (int64, error) {
	var mask int64
	for _, category := range categories {
		if category < 0 || category > push.MaxCategory {
			return 0, fmt.Errorf("category %d out of range", category)
		}
		mask |= 1 << uint(category)
	}
	return mask, nil
}

type okResponse struct {
	OK bool `json:"ok"`
}

// OwnerHeader carries the owner token, base64, on every write to a routing
// id: HKDF(seed, "push-owner" || routingId), so only the owner's own
// devices can produce it. A header rather than a body field so the
// DELETEs, which have no body, carry it the same way.
const OwnerHeader = "Push-Owner"

// ownerToken reads OwnerHeader, writing the 400 itself when it's unusable.
func ownerToken(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	token, err := base64.StdEncoding.DecodeString(r.Header.Get(OwnerHeader))
	if err != nil || len(token) != 32 {
		httputil.WriteError(w, http.StatusBadRequest, OwnerHeader+" must be 32 base64-encoded bytes")
		return nil, false
	}
	return token, true
}

// writeOwnershipError answers the two errors every guarded write shares,
// reporting whether it did.
func writeOwnershipError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, push.ErrNotOwner):
		httputil.WriteError(w, http.StatusForbidden, "not the owner of this routing id")
	case errors.Is(err, push.ErrPushRoutingNotFound):
		httputil.WriteError(w, http.StatusNotFound, "this routing id is not registered")
	default:
		return false
	}
	return true
}

type PutPrefsHandler struct {
	Service *push.Service
}

func (h *PutPrefsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	pushRoutingID := r.PathValue("pushRoutingId")
	owner, ok := ownerToken(w, r)
	if !ok {
		return
	}

	var req putPrefsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	pushFanoutHash, err := base64.StdEncoding.DecodeString(req.PushFanoutHash)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "pushFanoutHash must be base64-encoded")
		return
	}
	// Exactly sha256's width: a short hash still compares equal to itself,
	// so a one-byte "hash" would be forgeable by guessing a byte.
	if len(pushFanoutHash) != 32 {
		httputil.WriteError(w, http.StatusBadRequest, "pushFanoutHash must be 32 bytes")
		return
	}
	categoryMask, err := packCategories(req.Categories)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	prefs := push.Prefs{PushFanoutHash: pushFanoutHash, CategoryMask: categoryMask, KeyVersion: req.KeyVersion}
	err = h.Service.PutPrefs(r.Context(), pushRoutingID, prefs, owner)
	if writeOwnershipError(w, err) {
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to store push preferences")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}

type putDeviceRequest struct {
	// Base64 of the platform token as-is: the relay has to hand APNs/FCM
	// the real token, so it isn't encrypted beyond storage at rest.
	PushToken string `json:"pushToken"`
	Platform  string `json:"platform"`
	Enabled   bool   `json:"enabled"`
}

type PutDeviceHandler struct {
	Service *push.Service
}

func (h *PutDeviceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	pushRoutingID := r.PathValue("pushRoutingId")
	deviceID := r.PathValue("deviceId")
	owner, ok := ownerToken(w, r)
	if !ok {
		return
	}

	var req putDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	pushToken, err := base64.StdEncoding.DecodeString(req.PushToken)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "pushToken must be base64-encoded")
		return
	}
	if len(pushToken) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "pushToken is required")
		return
	}
	if len(pushToken) > MaxPushTokenBytes {
		httputil.WriteError(w, http.StatusBadRequest, "pushToken is too large")
		return
	}
	if req.Platform != "ios" && req.Platform != "android" {
		httputil.WriteError(w, http.StatusBadRequest, "platform must be ios or android")
		return
	}

	device := push.Device{
		DeviceID:  deviceID,
		PushToken: pushToken,
		Platform:  req.Platform,
		Enabled:   req.Enabled,
	}
	err = h.Service.PutDevice(r.Context(), pushRoutingID, device, owner)
	if writeOwnershipError(w, err) {
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to store push device")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}

type setSilencedRequest struct {
	Silenced bool `json:"silenced"`
}

// SetSilencedHandler flips the flag without touching the hash or
// categories, so unsilencing needs no content key and cannot half-fail.
type SetSilencedHandler struct {
	Service *push.Service
}

func (h *SetSilencedHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	owner, ok := ownerToken(w, r)
	if !ok {
		return
	}

	var req setSilencedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	err := h.Service.SetSilenced(r.Context(), r.PathValue("pushRoutingId"), req.Silenced, owner)
	if writeOwnershipError(w, err) {
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to change notification settings")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}

type DeleteDeviceHandler struct {
	Service *push.Service
}

func (h *DeleteDeviceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	owner, ok := ownerToken(w, r)
	if !ok {
		return
	}
	err := h.Service.DeleteDevice(r.Context(), r.PathValue("pushRoutingId"), r.PathValue("deviceId"), owner)
	if writeOwnershipError(w, err) {
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to remove push device")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}

// DeleteRoutingHandler silences a circle outright. Idempotent.
type DeleteRoutingHandler struct {
	Service *push.Service
}

func (h *DeleteRoutingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	owner, ok := ownerToken(w, r)
	if !ok {
		return
	}
	err := h.Service.DeleteRouting(r.Context(), r.PathValue("pushRoutingId"), owner)
	if writeOwnershipError(w, err) {
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to remove push routing")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}
