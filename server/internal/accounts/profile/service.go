package profile

import (
	"context"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type store interface {
	GetProfile(ctx context.Context, accountID string) (accounts.Profile, error)
	SetProfile(ctx context.Context, accountID, name string) error
	SetPublicKey(ctx context.Context, accountID string, publicKey []byte) error
}

// rewrapper is the circles column's side of replacing a keypair: every
// membership this account holds is flagged, so the next member to sync
// reseals the content keys to the new key.
type rewrapper interface {
	MarkMembershipsNeedRewrap(ctx context.Context, accountID string) ([]string, error)
}

type Service struct {
	Store store
	// Circles is what turns a new public key into a repair. Without it a
	// replaced key would leave every circle unreadable with nothing
	// asking anyone to fix it.
	Circles rewrapper
	// Notify wakes the other members so one of them reseals. Without it
	// a recovering device waits for someone to open the app.
	Notify circles.Notifier
}

func (s *Service) Get(ctx context.Context, accountID string) (accounts.Profile, error) {
	return s.Store.GetProfile(ctx, accountID)
}

func (s *Service) Set(ctx context.Context, accountID, name string) (accounts.Profile, error) {
	if err := s.Store.SetProfile(ctx, accountID, name); err != nil {
		return accounts.Profile{}, err
	}
	return s.Store.GetProfile(ctx, accountID)
}

// SetPublicKey publishes the key members seal to. reset says this device
// has no private key and made a new pair, which makes every sealed copy
// unreadable: the memberships are flagged so another member reseals
// them. Returns the circles now waiting on that.
func (s *Service) SetPublicKey(ctx context.Context, accountID string, publicKey []byte, reset bool) ([]string, error) {
	if err := s.Store.SetPublicKey(ctx, accountID, publicKey); err != nil {
		return nil, err
	}
	if !reset || s.Circles == nil {
		return nil, nil
	}
	waiting, err := s.Circles.MarkMembershipsNeedRewrap(ctx, accountID)
	if err != nil {
		return nil, err
	}
	// Two pushes per circle. The silent one fixes it with nobody
	// involved, when a device happens to be awake. The card is what
	// covers the case where none are, since a background wake is
	// throttled by both platforms and dropped after a force quit.
	if s.Notify != nil {
		for _, circleID := range waiting {
			s.Notify.Notify(ctx, circles.Notification{
				Kind: circles.NotifyRoster, CircleID: circleID, ActorID: accountID,
			})
			s.Notify.Notify(ctx, circles.Notification{
				Kind: circles.NotifyRewrapNeeded, CircleID: circleID, ActorID: accountID,
			})
		}
	}
	return waiting, nil
}
