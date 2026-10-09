package ses

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"

	"mimoza-relay/internal/feedback"
)

type fakeAPI struct {
	in  *sesv2.SendEmailInput
	err error
}

func (f *fakeAPI) SendEmail(_ context.Context, in *sesv2.SendEmailInput, _ ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error) {
	f.in = in
	return &sesv2.SendEmailOutput{}, f.err
}

func sampleReport() feedback.Report {
	return feedback.Report{
		ReportID:  "abc123",
		AccountID: "acct-1",
		Kind:      feedback.KindBug,
		Message:   "The feed is blank after I rotate the phone.\nSecond line.",
		Email:     "me@example.com",
		Context: feedback.Context{
			AppVersion: "1.0.0", Build: "113.114", Platform: "iOS", OSVersion: "26.0",
			Device: "iPhone 15", Language: "en", Environment: "staging",
		},
		CreatedAt: time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC),
	}
}

func TestNotify_SendsTheReportAsSESExpects(t *testing.T) {
	api := &fakeAPI{}
	sender := &Sender{Client: api, From: "support@example.com", To: "hello@example.com", Environment: "staging"}
	if err := sender.Notify(context.Background(), sampleReport()); err != nil {
		t.Fatal(err)
	}

	in := api.in
	if aws.ToString(in.FromEmailAddress) != "support@example.com" {
		t.Errorf("from = %q", aws.ToString(in.FromEmailAddress))
	}
	if len(in.Destination.ToAddresses) != 1 || in.Destination.ToAddresses[0] != "hello@example.com" {
		t.Errorf("to = %v", in.Destination.ToAddresses)
	}
	if len(in.ReplyToAddresses) != 1 || in.ReplyToAddresses[0] != "me@example.com" {
		t.Errorf("reply-to = %v", in.ReplyToAddresses)
	}
	subject := aws.ToString(in.Content.Simple.Subject.Data)
	if subject != "[Mimoza staging] Bug: The feed is blank after I rotate the phone." {
		t.Errorf("subject = %q", subject)
	}
	body := aws.ToString(in.Content.Simple.Body.Text.Data)
	for _, want := range []string{"Second line.", "Reply to: me@example.com", "App: 1.0.0 (113.114)", "Device: iPhone 15, iOS 26.0", "Account: acct-1", "Report: abc123 at 2026-10-09T12:00:00Z"} {
		if !strings.Contains(body, want) {
			t.Errorf("body is missing %q:\n%s", want, body)
		}
	}
}

func TestNotify_NoEmailMeansNoReplyTo(t *testing.T) {
	api := &fakeAPI{}
	sender := &Sender{Client: api, From: "a@example.com", To: "b@example.com"}
	report := sampleReport()
	report.Email = ""
	if err := sender.Notify(context.Background(), report); err != nil {
		t.Fatal(err)
	}
	if len(api.in.ReplyToAddresses) != 0 {
		t.Errorf("reply-to = %v without an email", api.in.ReplyToAddresses)
	}
	if !strings.Contains(aws.ToString(api.in.Content.Simple.Body.Text.Data), "Reply to: not given") {
		t.Error("body does not say the email is missing")
	}
}

func TestNotify_ReportsSESRefusal(t *testing.T) {
	want := errors.New("MessageRejected: Email address is not verified")
	sender := &Sender{Client: &fakeAPI{err: want}, From: "a@example.com", To: "b@example.com"}
	err := sender.Notify(context.Background(), sampleReport())
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want it to wrap %v", err, want)
	}
}

func TestSubject_TruncatesALongFirstLine(t *testing.T) {
	report := sampleReport()
	report.Message = strings.Repeat("ab", 50) + "\nmore"
	subject := Subject("prod", report)
	if !strings.HasSuffix(subject, "…") || strings.Contains(subject, "more") {
		t.Errorf("subject = %q", subject)
	}
}
