package submit

import (
	"context"
	"errors"
	"testing"
	"time"

	"mimoza-relay/internal/feedback"
)

type fakeNotifier struct {
	notified []feedback.Report
	err      error
}

func (f *fakeNotifier) Notify(_ context.Context, report feedback.Report) error {
	f.notified = append(f.notified, report)
	return f.err
}

func TestSubmit_Notifies(t *testing.T) {
	notify := &fakeNotifier{}
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	service := &Service{Notify: notify, Now: func() time.Time { return now }}

	report, err := service.Submit(context.Background(), "acct-1", feedback.KindBug, "it broke", "me@example.com", feedback.Context{Build: "113.114"})
	if err != nil {
		t.Fatal(err)
	}
	if report.ReportID == "" {
		t.Fatal("expected a report id")
	}
	if len(notify.notified) != 1 || notify.notified[0].ReportID != report.ReportID {
		t.Fatalf("notified %+v, want the returned report", notify.notified)
	}
	sent := notify.notified[0]
	if sent.AccountID != "acct-1" || sent.Kind != feedback.KindBug || sent.Message != "it broke" || sent.Email != "me@example.com" || sent.Context.Build != "113.114" {
		t.Errorf("report lost a field: %+v", sent)
	}
	if !sent.CreatedAt.Equal(now) {
		t.Errorf("createdAt = %v, want %v", sent.CreatedAt, now)
	}
}

func TestSubmit_NotifyFailureIsTheCallers(t *testing.T) {
	want := errors.New("ses down")
	service := &Service{Notify: &fakeNotifier{err: want}}

	_, err := service.Submit(context.Background(), "acct-1", feedback.KindFeedback, "what if", "", feedback.Context{})
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v: nothing kept a copy", err, want)
	}
}

func TestSubmit_WithoutNotifierRefuses(t *testing.T) {
	service := &Service{}
	_, err := service.Submit(context.Background(), "acct-1", feedback.KindContent, "that photo", "", feedback.Context{})
	if !errors.Is(err, feedback.ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

func TestSubmit_EveryReportGetsItsOwnID(t *testing.T) {
	service := &Service{Notify: &fakeNotifier{}}
	seen := map[string]bool{}
	for range 20 {
		report, err := service.Submit(context.Background(), "acct-1", feedback.KindBug, "x", "", feedback.Context{})
		if err != nil {
			t.Fatal(err)
		}
		if seen[report.ReportID] {
			t.Fatalf("report id %s minted twice", report.ReportID)
		}
		seen[report.ReportID] = true
	}
}
