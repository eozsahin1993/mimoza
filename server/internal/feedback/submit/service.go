package submit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"mimoza-relay/internal/feedback"
)

type Service struct {
	// Notify is nil where no sender is configured, and Submit says so
	// rather than pretending: a report that reaches nobody is lost.
	Notify feedback.Notifier
	// Now is the relay's clock, replaced in tests.
	Now func() time.Time
}

// Submit sends the report on. The id is minted here so the person and
// the email can name the same thing if they ever write back about it.
func (s *Service) Submit(ctx context.Context, accountID string, kind feedback.Kind, message, email string, c feedback.Context) (feedback.Report, error) {
	if s.Notify == nil {
		return feedback.Report{}, feedback.ErrNotConfigured
	}
	id, err := newReportID()
	if err != nil {
		return feedback.Report{}, err
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	report := feedback.Report{
		ReportID:  id,
		AccountID: accountID,
		Kind:      kind,
		Message:   message,
		Email:     email,
		Context:   c,
		CreatedAt: now().UTC(),
	}
	if err := s.Notify.Notify(ctx, report); err != nil {
		return feedback.Report{}, err
	}
	return report, nil
}

func newReportID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
