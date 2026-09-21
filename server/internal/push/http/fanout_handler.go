package push

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"mimoza-relay/internal/push"
	"mimoza-relay/internal/util/httputil"
)

type fanoutRequest struct {
	PushRoutingIDs []string `json:"pushRoutingIds"`
	// Base64. Proves the sender holds the circle's content key, without
	// naming the circle or the sender.
	PushFanoutToken string `json:"pushFanoutToken"`
	Category        int64  `json:"category"`
	// Which content-key version the payload is encrypted under. Already
	// plaintext on every append, so it costs nothing to name here.
	KeyVersion int64 `json:"keyVersion"`
	// Base64 ciphertext, forwarded untouched. Empty is allowed.
	Payload string `json:"payload"`
}

// Totals only — see FanoutResult. Push is best-effort and unacknowledged,
// so a caller has no use for per-target detail anyway.
type fanoutResponse struct {
	Delivered int `json:"delivered"`
	Skipped   int `json:"skipped"`
}

// FanoutHandler is the one unauthenticated route on the relay, and that is
// deliberate. An authenticated send arrives beside an identified poster,
// and a few posts from different members let the relay solve a circle's
// membership by elimination — each poster's own routing id is missing from
// their own fanout. Authorization comes from the fanout token instead.
type FanoutHandler struct {
	Service *push.Service
	// Nil until the platform credentials exist. Split out so tests can run
	// the resolution path without APNs or FCM.
	Dispatch func(delivery push.Delivery, keyVersion int64, payload []byte)
}

func (h *FanoutHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req fanoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	pushFanoutToken, err := base64.StdEncoding.DecodeString(req.PushFanoutToken)
	if err != nil || len(pushFanoutToken) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "pushFanoutToken must be non-empty base64")
		return
	}
	// May be empty: a push the recipient reads from its own state (a
	// pending request's) needs no ciphertext, and the kind's Alert covers
	// the text.
	payload, err := base64.StdEncoding.DecodeString(req.Payload)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "payload must be base64")
		return
	}
	if len(req.PushRoutingIDs) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "pushRoutingIds is required")
		return
	}

	result, err := h.Service.Fanout(r.Context(), req.PushRoutingIDs, pushFanoutToken, req.Category)
	if errors.Is(err, push.ErrTooManyTargets) {
		httputil.WriteError(w, http.StatusBadRequest, "too many pushRoutingIds")
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to fan out")
		return
	}

	for _, delivery := range result.Deliveries {
		h.Dispatch(delivery, req.KeyVersion, payload)
	}

	httputil.WriteJSON(w, http.StatusOK, fanoutResponse{Delivered: len(result.Deliveries), Skipped: result.Skipped})
}
