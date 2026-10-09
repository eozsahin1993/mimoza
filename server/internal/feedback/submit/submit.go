package submit

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"unicode/utf8"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/feedback"
	"mimoza-relay/internal/util/httputil"
)

// Limits on what one report may carry. The message cap is generous for a
// typed note and far below anything that could be a dump; the context
// caps keep a hostile client from using the table as free storage.
const (
	MaxMessageLength = 4000
	MaxEmailLength   = 254
	MaxContextLength = 200
	// maxBodyBytes bounds the decode itself, before any field is looked at.
	maxBodyBytes = 16 * 1024
)

type submitRequest struct {
	Kind    feedback.Kind    `json:"kind"`
	Message string           `json:"message"`
	Email   string           `json:"email"`
	Context feedback.Context `json:"context"`
}

type submitResponse struct {
	ReportID string `json:"reportId"`
}

type Handler struct{ Service *Service }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body submitRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&body); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "body must be JSON")
		return
	}
	if !body.Kind.Valid() {
		httputil.WriteError(w, http.StatusBadRequest, "kind must be bug, content or feedback")
		return
	}
	body.Message = strings.TrimSpace(body.Message)
	if body.Message == "" {
		httputil.WriteError(w, http.StatusBadRequest, "message is required")
		return
	}
	if utf8.RuneCountInString(body.Message) > MaxMessageLength {
		httputil.WriteError(w, http.StatusBadRequest, "message is too long")
		return
	}
	body.Email = strings.TrimSpace(body.Email)
	if body.Email != "" && !validEmail(body.Email) {
		httputil.WriteError(w, http.StatusBadRequest, "email is not an address")
		return
	}
	if !validContext(body.Context) {
		httputil.WriteError(w, http.StatusBadRequest, "context fields are too long")
		return
	}

	report, err := h.Service.Submit(r.Context(), auth.AccountID(r.Context()), body.Kind, body.Message, body.Email, body.Context)
	if errors.Is(err, feedback.ErrNotConfigured) {
		httputil.WriteError(w, http.StatusServiceUnavailable, "feedback is not set up on this relay")
		return
	}
	if err != nil {
		// The message is what the person typed, and nothing kept a copy:
		// logged so a failed send is at least findable, never silently lost.
		httputil.Log(r.Context(), slog.LevelError, "feedback could not be sent",
			"reason", "feedback_send_failed", "error", err, "accountId", auth.AccountID(r.Context()), "kind", body.Kind)
		httputil.WriteError(w, http.StatusBadGateway, "feedback could not be sent")
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, submitResponse{ReportID: report.ReportID})
}

// validEmail is the loosest check that still refuses a sentence typed
// into the wrong box: a parseable address with no display name.
func validEmail(email string) bool {
	if len(email) > MaxEmailLength {
		return false
	}
	parsed, err := mail.ParseAddress(email)
	return err == nil && parsed.Address == email
}

func validContext(c feedback.Context) bool {
	for _, field := range []string{c.AppVersion, c.Build, c.Platform, c.OSVersion, c.Device, c.Language, c.Environment} {
		if utf8.RuneCountInString(field) > MaxContextLength {
			return false
		}
	}
	return true
}
