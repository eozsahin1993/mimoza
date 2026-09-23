// Package notify turns something that happened in a circle into the
// notifications it should produce.
//
// The relay composes these itself. It knows who did what and where,
// because membership is plaintext, and it cannot read the photo or the
// comment, so a card says who and where and never what. Text is a
// localization key and its arguments rather than words: the device knows
// its own language, and the relay does not.
package notify

import (
	"context"

	"mimoza-relay/internal/circles"
)

// Message is one notification. Silent carries no card at all — it is how
// a roster change wakes a phone to sync.
type Message struct {
	TitleKey string
	BodyKey  string
	Args     []string
	// Data is what a tap routes on: the circle, the entry, and the post
	// a comment or reaction hangs off.
	Data   map[string]string
	Silent bool
}

// Sender delivers one message to one device of one platform. Nil where
// an environment has no push credentials, which is every local run.
type Sender func(ctx context.Context, token, platform string, message Message) error

// What happened, named by the circles column so a slice reporting an
// event does not have to import this package.
type Kind = string

const (
	KindPost        = circles.NotifyPost
	KindComment     = circles.NotifyComment
	KindReaction    = circles.NotifyReaction
	KindJoinRequest = circles.NotifyJoinRequest
	KindApproved    = circles.NotifyApproved
	KindRewrapped   = circles.NotifyRewrapped
	KindRoster      = circles.NotifyRoster
)

// Event is what a write handler reports once its write has landed. It is
// circles.Notification by another name: the circles column declares the
// shape it hands over, and this package is what satisfies it.
type Event = circles.Notification
