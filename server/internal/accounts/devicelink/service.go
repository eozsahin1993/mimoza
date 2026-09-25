package devicelink

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"mimoza-relay/internal/accounts"
)

type store interface {
	PutLink(ctx context.Context, accountID string, link accounts.DeviceLink) error
	GetLink(ctx context.Context, accountID, sessionID string) (accounts.DeviceLink, error)
	SaveSealedKeypair(ctx context.Context, accountID, sessionID string, sealed []byte) error
}

type Service struct {
	Store store
	// Retention is how long an open session lasts. Zero takes the default.
	Retention time.Duration
	// Now is the relay's clock, replaced in tests.
	Now func() time.Time
}

// Create starts a session for the phone that has no keypair yet. The
// public key goes back out in the QR so the other phone seals to a key it
// read off the screen, not one this relay handed it.
func (s *Service) Create(ctx context.Context, accountID string, publicKey []byte) (accounts.DeviceLink, error) {
	now := s.now()
	link := accounts.DeviceLink{
		SessionID: newSessionID(),
		PublicKey: publicKey,
		CreatedAt: now,
		ExpiresAt: now.Add(s.retention()),
	}
	if err := s.Store.PutLink(ctx, accountID, link); err != nil {
		return accounts.DeviceLink{}, err
	}
	return link, nil
}

// Send is the answering phone posting the sealed keypair. First one wins.
func (s *Service) Send(ctx context.Context, accountID, sessionID string, sealed []byte) error {
	return s.Store.SaveSealedKeypair(ctx, accountID, sessionID, sealed)
}

// Get is what the waiting phone polls. An unanswered session still comes
// back, so the caller can tell "not yet" from "gone".
func (s *Service) Get(ctx context.Context, accountID, sessionID string) (accounts.DeviceLink, error) {
	return s.Store.GetLink(ctx, accountID, sessionID)
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) retention() time.Duration {
	if s.Retention > 0 {
		return s.Retention
	}
	return accounts.DefaultDeviceLinkRetention
}

func newSessionID() string {
	buf := make([]byte, 16)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
