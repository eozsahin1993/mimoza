// Package feedback is what someone using the app tells us on purpose: a
// bug, something posted that should not have been, or anything else. It is the
// one thing passing through the relay that a person wrote for us to
// read, so it is kept apart from the circles, where nothing is readable.
//
// A report is emailed and nothing else: there is no table, so a send
// that fails is a request that fails, and the person is told to try
// again or write to us directly.
package feedback

import (
	"context"
	"errors"
	"time"
)

const (
	SupportInbox  = "hello@joinmimoza.com"
	SenderAddress = "support@joinmimoza.com"
)

type Kind string

const (
	KindBug      Kind = "bug"
	KindContent  Kind = "content"
	KindFeedback Kind = "feedback"
)

// Kinds is every accepted kind, for validation and for tests.
var Kinds = []Kind{KindBug, KindContent, KindFeedback}

func (k Kind) Valid() bool {
	for _, known := range Kinds {
		if k == known {
			return true
		}
	}
	return false
}

// Context is what the app knows about itself when the report is sent.
type Context struct {
	AppVersion string `json:"appVersion"`
	// Build is the app's own label: the native build, and the CI run that
	// published the JavaScript when the two differ ("113.114").
	Build       string `json:"build"`
	Platform    string `json:"platform"`
	OSVersion   string `json:"osVersion"`
	Device      string `json:"device"`
	Language    string `json:"language"`
	Environment string `json:"environment"`
}

// Report is one message from one account.
type Report struct {
	ReportID  string
	AccountID string
	Kind      Kind
	Message   string
	// Email is where the person said we may reply, or empty. Never the
	// sign-in email: the relay does not keep one.
	Email     string
	Context   Context
	CreatedAt time.Time
}

type Notifier interface {
	Notify(ctx context.Context, report Report) error
}

// NotifierFunc adapts a function, for tests and for wiring a stand-in.
type NotifierFunc func(ctx context.Context, report Report) error

func (f NotifierFunc) Notify(ctx context.Context, report Report) error { return f(ctx, report) }

var ErrNotConfigured = errors.New("feedback: no sender configured")
