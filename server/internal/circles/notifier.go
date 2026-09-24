package circles

import "context"

// Notifier is what a write slice calls once its write has landed. It is
// declared here because every slice wants the same one, and satisfied by
// internal/push.
//
// Nothing returns an error: the write already happened, and a push that
// did not land is not something to make the caller repeat.
type Notifier interface {
	Notify(ctx context.Context, event Notification)
}

// Notification is what happened, in the terms the relay can describe it:
// who, where, and what kind. Never what was said.
type Notification struct {
	Kind     string
	CircleID string
	ActorID  string
	EntryID  string
	ParentID string
	AuthorID string
	// RequestID names the ask a join_request notification is about, so a
	// tap can check whether it's still the one waiting rather than
	// whichever one happens to be first — another admin may have already
	// answered it, or the same requester may have asked again since.
	RequestID string
	// Only is who this reaches when it is not the circle at large.
	Only []string
}

// Kinds of notification. These name the strings the app ships.
const (
	NotifyPost        = "post"
	NotifyComment     = "comment"
	NotifyReaction    = "reaction"
	NotifyJoinRequest = "join_request"
	NotifyApproved    = "approved"
	NotifyRewrapped   = "rewrapped"
	// NotifyRewrapNeeded asks a circle's admins to let someone back in.
	// A card rather than a nudge: the silent push that goes out beside
	// it is throttled by both platforms and dropped after a force quit,
	// so waiting on it can mean waiting days.
	NotifyRewrapNeeded = "rewrap_needed"
	// NotifyRoster is silent: a nudge to re-sync, not a card.
	NotifyRoster = "roster"
)
