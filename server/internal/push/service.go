package push

import (
	"context"
	"crypto/hmac"
	"errors"

	"mimoza-relay/internal/ratelimit"
)

// MaxFanoutTargets caps one send. A circle's membership is bounded, so a
// larger request isn't a real one, and rejecting costs no storage reads.
const MaxFanoutTargets = 256

type Service struct {
	PushStore Store
	// Keyed on the routing id. The only limit here protecting a person
	// rather than the relay: verification stops an outsider, but a real
	// member passes it every time and nothing else bounds them.
	RecipientLimit ratelimit.Store
}

// ErrTooManyTargets is returned when a send exceeds MaxFanoutTargets.
var ErrTooManyTargets = errors.New("push: too many fanout targets")

// Every write below takes the caller's owner token. PutPrefs is the one
// that can claim a row; the rest require it already claimed by the same
// token. Checking before writing is safe because an OwnerHash, once set,
// never changes.

func (s *Service) PutPrefs(ctx context.Context, pushRoutingID string, prefs Prefs, ownerToken []byte) error {
	prefs.OwnerHash = OwnerHash(ownerToken, pushRoutingID)
	return s.PushStore.PutPrefs(ctx, pushRoutingID, prefs)
}

func (s *Service) SetSilenced(ctx context.Context, pushRoutingID string, silenced bool, ownerToken []byte) error {
	if _, err := s.authorize(ctx, pushRoutingID, ownerToken); err != nil {
		return err
	}
	return s.PushStore.SetSilenced(ctx, pushRoutingID, silenced)
}

// PutDevice needs the prefs row to exist: a device can't claim an address,
// only join one its owner already holds.
func (s *Service) PutDevice(ctx context.Context, pushRoutingID string, device Device, ownerToken []byte) error {
	prefs, err := s.authorize(ctx, pushRoutingID, ownerToken)
	if err != nil {
		return err
	}
	// A device row lives exactly as long as the address it belongs to.
	device.Temporary = prefs.Kind.Temporary()
	return s.PushStore.PutDevice(ctx, pushRoutingID, device)
}

// DeleteDevice and DeleteRouting go ahead when there is no prefs row:
// nothing is left to protect, and the device rows are already unreachable.
func (s *Service) DeleteDevice(ctx context.Context, pushRoutingID, deviceID string, ownerToken []byte) error {
	if _, err := s.authorize(ctx, pushRoutingID, ownerToken); err != nil && !errors.Is(err, ErrPushRoutingNotFound) {
		return err
	}
	return s.PushStore.DeleteDevice(ctx, pushRoutingID, deviceID)
}

func (s *Service) DeleteRouting(ctx context.Context, pushRoutingID string, ownerToken []byte) error {
	if _, err := s.authorize(ctx, pushRoutingID, ownerToken); err != nil && !errors.Is(err, ErrPushRoutingNotFound) {
		return err
	}
	return s.PushStore.DeleteRouting(ctx, pushRoutingID)
}

func (s *Service) authorize(ctx context.Context, pushRoutingID string, ownerToken []byte) (*Prefs, error) {
	prefs, err := s.PushStore.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		return nil, err
	}
	// Constant time, as for the fanout hash.
	if len(prefs.OwnerHash) == 0 || !hmac.Equal(prefs.OwnerHash, OwnerHash(ownerToken, pushRoutingID)) {
		return nil, ErrNotOwner
	}
	return prefs, nil
}

// Delivery is one resolved target.
type Delivery struct {
	PushToken []byte
	Platform  string
	// Which routing id resolved to this device — the receiving app uses it
	// to find the circle without trial-decrypting against all of them.
	PushRoutingID string
	// The address's own kind, from its prefs row: the dispatchers attach
	// its Alert, and the device picks its own line by it.
	Kind PushKind
}

// FanoutResult is counts, not per-target detail: saying *which* ids failed
// would make this an oracle for probing which ones exist.
type FanoutResult struct {
	Deliveries []Delivery
	Skipped    int
}

// Fanout resolves a send into the deliveries it should produce.
//
// Order is load-bearing: cap, then verify, then charge budget. Budgeting
// first would let an attacker cycling random ids make the relay *write* a
// row per nonexistent target — the limiter becomes the amplification.
//
// A failed target is skipped, never fatal: one recipient over budget must
// not silence the rest of the circle.
func (s *Service) Fanout(ctx context.Context, pushRoutingIDs []string, pushFanoutToken []byte, category int64) (FanoutResult, error) {
	if len(pushRoutingIDs) > MaxFanoutTargets {
		return FanoutResult{}, ErrTooManyTargets
	}

	var result FanoutResult
	for _, pushRoutingID := range pushRoutingIDs {
		deliveries, err := s.resolve(ctx, pushRoutingID, pushFanoutToken, category)
		if err != nil {
			return FanoutResult{}, err
		}
		if len(deliveries) == 0 {
			result.Skipped++
			continue
		}
		result.Deliveries = append(result.Deliveries, deliveries...)
	}
	return result, nil
}

// resolve returns one routing id's deliveries, or nil to skip. Only a
// storage failure is an error — the caller must not learn which targets
// were rejected, or why.
func (s *Service) resolve(ctx context.Context, pushRoutingID string, pushFanoutToken []byte, category int64) ([]Delivery, error) {
	prefs, err := s.PushStore.GetPrefs(ctx, pushRoutingID)
	if errors.Is(err, ErrPushRoutingNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Constant time, or a caller could test tokens a byte at a time.
	if prefs.Silenced {
		return nil, nil
	}
	if !hmac.Equal(prefs.PushFanoutHash, PushFanoutHash(pushFanoutToken, pushRoutingID)) {
		return nil, nil
	}
	if category < 0 || category > MaxCategory || prefs.CategoryMask&(1<<uint(category)) == 0 {
		return nil, nil
	}

	allowed, err := s.RecipientLimit.Allow(ctx, pushRoutingID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, nil
	}

	devices, err := s.PushStore.ListDevices(ctx, pushRoutingID)
	if err != nil {
		return nil, err
	}

	deliveries := make([]Delivery, 0, len(devices))
	for _, device := range devices {
		if !device.Enabled {
			continue
		}
		deliveries = append(deliveries, Delivery{
			PushToken:     device.PushToken,
			Platform:      device.Platform,
			PushRoutingID: pushRoutingID,
			Kind:          prefs.Kind,
		})
	}
	return deliveries, nil
}
