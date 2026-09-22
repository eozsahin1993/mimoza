package devices

import (
	"context"

	"mimoza-relay/internal/accounts"
)

type store interface {
	PutDevice(ctx context.Context, accountID string, device accounts.Device) error
	DeleteDevice(ctx context.Context, accountID, deviceID string) error
}

type Service struct {
	Store store
}

// Put registers or updates one phone. A push token rotates on its own
// schedule, so this is sent on every launch rather than once.
func (s *Service) Put(ctx context.Context, accountID string, device accounts.Device) error {
	return s.Store.PutDevice(ctx, accountID, device)
}

func (s *Service) Delete(ctx context.Context, accountID, deviceID string) error {
	return s.Store.DeleteDevice(ctx, accountID, deviceID)
}
