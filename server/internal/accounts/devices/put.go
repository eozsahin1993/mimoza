package devices

import (
	"encoding/json"
	"net/http"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/httputil"
)

type putRequest struct {
	PushToken string `json:"pushToken"`
	Platform  string `json:"platform"`
	Locale    string `json:"locale"`
}

type PutHandler struct{ Service *Service }

func (h *PutHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body putRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if body.PushToken == "" {
		httputil.WriteError(w, http.StatusBadRequest, "pushToken is required")
		return
	}
	if body.Platform != accounts.PlatformIOS && body.Platform != accounts.PlatformAndroid {
		httputil.WriteError(w, http.StatusBadRequest, "platform must be ios or android")
		return
	}

	err := h.Service.Put(r.Context(), auth.AccountID(r.Context()), accounts.Device{
		DeviceID:  r.PathValue("deviceId"),
		PushToken: body.PushToken,
		Platform:  body.Platform,
		Locale:    body.Locale,
	})
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "something went wrong")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
