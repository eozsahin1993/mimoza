package notify

import (
	"context"
	"log/slog"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type circleReader interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	ListMembers(ctx context.Context, circleID string) ([]circles.Member, error)
}

type accountReader interface {
	GetProfile(ctx context.Context, accountID string) (accounts.Profile, error)
	ListDevices(ctx context.Context, accountID string) ([]accounts.Device, error)
}

// Notifier fans one event out to the phones it should reach. It runs
// inside the handler that wrote the thing, so a failure here is logged
// rather than returned: the write already happened, and telling the
// caller it failed would have them repeat it.
type Notifier struct {
	Circles  circleReader
	Accounts accountReader
	// Send is nil until an environment has push credentials. Fanout
	// still resolves and reports; it just delivers nothing.
	Send Sender
}

// Notify resolves who should hear about this and tells them.
func (n *Notifier) Notify(ctx context.Context, event Event) {
	if n == nil {
		return
	}

	recipients, circleName, err := n.recipients(ctx, event)
	if err != nil {
		slog.ErrorContext(ctx, "could not work out who to notify",
			"reason", "fanout_unresolved", "error", err, "circleId", event.CircleID, "type", event.Kind)
		return
	}

	actor := ""
	if event.ActorID != "" {
		if profile, err := n.Accounts.GetProfile(ctx, event.ActorID); err == nil {
			actor = profile.Name
		}
	}

	delivered, skipped := 0, 0
	for _, recipient := range recipients {
		devices, err := n.Accounts.ListDevices(ctx, recipient)
		if err != nil {
			slog.ErrorContext(ctx, "could not read an account's devices",
				"reason", "devices_unreadable", "error", err, "accountId", recipient)
			continue
		}
		message := compose(event, actor, circleName, recipient)
		for _, device := range devices {
			if n.Send == nil {
				skipped++
				continue
			}
			if err := n.Send(ctx, device.PushToken, device.Platform, message); err != nil {
				skipped++
				slog.WarnContext(ctx, "a push did not land",
					"reason", "push_failed", "error", err, "platform", device.Platform)
				continue
			}
			delivered++
		}
	}

	slog.InfoContext(ctx, "notified",
		"circleId", event.CircleID, "type", event.Kind, "entryId", event.EntryID,
		"recipients", len(recipients), "delivered", delivered, "skipped", skipped)
}

// recipients is everyone who should hear about this, never including
// whoever did it.
func (n *Notifier) recipients(ctx context.Context, event Event) ([]string, string, error) {
	if len(event.Only) > 0 {
		circle, err := n.Circles.GetCircle(ctx, event.CircleID)
		if err != nil {
			return nil, "", err
		}
		return without(event.Only, event.ActorID), circle.Name, nil
	}

	circle, err := n.Circles.GetCircle(ctx, event.CircleID)
	if err != nil {
		return nil, "", err
	}
	roster, err := n.Circles.ListMembers(ctx, event.CircleID)
	if err != nil {
		return nil, "", err
	}

	var recipients []string
	for _, member := range roster {
		if member.AccountID == event.ActorID {
			continue
		}
		// The author of the photo hears about a comment or a reaction on
		// it whatever else they have silenced, short of silencing
		// everything.
		own := member.AccountID == event.AuthorID && member.NotifyLevel != circles.NotifyNone
		if !own && !covers(member.NotifyLevel, event.Kind) {
			continue
		}
		recipients = append(recipients, member.AccountID)
	}
	return recipients, circle.Name, nil
}

// admins is who answers a join request.
func Admins(roster []circles.Member) []string {
	var admins []string
	for _, member := range roster {
		if member.IsAdmin() {
			admins = append(admins, member.AccountID)
		}
	}
	return admins
}

func without(accounts []string, exclude string) []string {
	out := make([]string, 0, len(accounts))
	for _, accountID := range accounts {
		if accountID != exclude {
			out = append(out, accountID)
		}
	}
	return out
}
