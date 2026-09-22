package posts

import (
	"net/http"
	"strconv"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/httputil"
)

// defaultLimit and maxLimit bound a page. A device asks for what it can
// apply in one pass; the cap is what stops one request reading a whole
// circle's history.
const (
	defaultLimit = 200
	maxLimit     = 200
)

type walkResponse struct {
	Entries []circles.EntryView `json:"entries"`
	// Next and Prev are opaque: the relay reads them, the device stores
	// and returns them. Which index they walk is not the device's
	// business and can change without breaking one.
	Next string `json:"next,omitempty"`
	Prev string `json:"prev,omitempty"`
	More bool   `json:"more"`
}

type countResponse struct {
	Count int64 `json:"count"`
}

type WalkHandler struct {
	Service *Service
}

func (h *WalkHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	circleID := r.PathValue("circleId")
	accountID := auth.AccountID(r.Context())

	entryType := r.URL.Query().Get("type")
	if entryType != circles.TypePost && entryType != circles.TypeActivity {
		httputil.WriteError(w, http.StatusBadRequest, "type must be post or activity")
		return
	}

	// A count instead of a page: the same route, because it answers a
	// question about the same stream and takes the same authorization.
	if r.URL.Query().Get("count") != "" {
		total, err := h.Service.Count(r.Context(), circleID, accountID, entryType)
		if err != nil {
			status, message := circles.Status(err)
			httputil.WriteError(w, status, message)
			return
		}
		httputil.WriteJSON(w, http.StatusOK, countResponse{Count: total})
		return
	}

	cursor, err := circles.ParseCursor(r.URL.Query().Get("cursor"), entryType)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "cursor is not one this relay handed out")
		return
	}

	limit := int32(defaultLimit)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || parsed <= 0 {
			httputil.WriteError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(int32(parsed), maxLimit)
	}

	page, err := h.Service.Walk(r.Context(), circleID, accountID, cursor, limit)
	if err != nil {
		status, message := circles.Status(err)
		httputil.WriteError(w, status, message)
		return
	}

	body := walkResponse{Entries: make([]circles.EntryView, 0, len(page.Entries)), More: page.More}
	for _, entry := range page.Entries {
		body.Entries = append(body.Entries, circles.FromEntry(entry))
	}
	body.Next = page.Next.Encode()
	body.Prev = page.Prev.Encode()
	httputil.WriteJSON(w, http.StatusOK, body)
}
