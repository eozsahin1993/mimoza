// Package ses emails a feedback report through Amazon SES. Picked over a
// third-party sender because the relay already runs under an IAM role:
// no token to mint, store or rotate, only a policy line and a verified
// domain. The account stays in SES's sandbox on purpose, since both ends
// of every send are ours.
package ses

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/aws/aws-sdk-go-v2/service/sesv2/types"

	"mimoza-relay/internal/feedback"
)

// api is the one SES call this package makes, as an interface so the
// tests can read what would have been sent without an AWS account.
type api interface {
	SendEmail(ctx context.Context, in *sesv2.SendEmailInput, opts ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error)
}

type Sender struct {
	Client api
	From   string
	To     string
	// Environment names the relay in the subject, so staging reports are
	// never mistaken for production ones in a shared inbox.
	Environment string
}

var _ feedback.Notifier = (*Sender)(nil)

func (s *Sender) Notify(ctx context.Context, report feedback.Report) error {
	in := &sesv2.SendEmailInput{
		FromEmailAddress: aws.String(s.From),
		Destination:      &types.Destination{ToAddresses: []string{s.To}},
		Content: &types.EmailContent{
			Simple: &types.Message{
				Subject: &types.Content{Data: aws.String(Subject(s.Environment, report)), Charset: aws.String("UTF-8")},
				Body:    &types.Body{Text: &types.Content{Data: aws.String(Body(report)), Charset: aws.String("UTF-8")}},
			},
		},
	}
	// Reply goes to the person, not to the sending address, when they
	// said we may.
	if report.Email != "" {
		in.ReplyToAddresses = []string{report.Email}
	}
	if _, err := s.Client.SendEmail(ctx, in); err != nil {
		return fmt.Errorf("send feedback email: %w", err)
	}
	return nil
}

// Subject is scannable in a list: environment, kind, and the opening
// words of the message.
func Subject(environment string, report feedback.Report) string {
	first := strings.SplitN(report.Message, "\n", 2)[0]
	if runes := []rune(first); len(runes) > 60 {
		first = string(runes[:60]) + "…"
	}
	return fmt.Sprintf("[Mimoza %s] %s: %s", environment, kindLabel(report.Kind), first)
}

// Body is plain text: the message as typed, then what the app attached,
// then what the relay knows. Nothing here is rendered, so no escaping.
func Body(report feedback.Report) string {
	var b strings.Builder
	b.WriteString(report.Message)
	b.WriteString("\n\n---\n")
	fmt.Fprintf(&b, "Kind: %s\n", kindLabel(report.Kind))
	if report.Email != "" {
		fmt.Fprintf(&b, "Reply to: %s\n", report.Email)
	} else {
		b.WriteString("Reply to: not given\n")
	}
	c := report.Context
	fmt.Fprintf(&b, "App: %s (%s)\n", c.AppVersion, c.Build)
	fmt.Fprintf(&b, "Device: %s, %s %s\n", c.Device, c.Platform, c.OSVersion)
	fmt.Fprintf(&b, "Language: %s\n", c.Language)
	fmt.Fprintf(&b, "Environment: %s\n", c.Environment)
	fmt.Fprintf(&b, "Account: %s\n", report.AccountID)
	fmt.Fprintf(&b, "Report: %s at %s\n", report.ReportID, report.CreatedAt.UTC().Format(time.RFC3339))
	return b.String()
}

func kindLabel(kind feedback.Kind) string {
	switch kind {
	case feedback.KindBug:
		return "Bug"
	case feedback.KindContent:
		return "Content report"
	case feedback.KindFeedback:
		return "Feedback"
	default:
		return string(kind)
	}
}
