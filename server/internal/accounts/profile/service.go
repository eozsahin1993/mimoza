package profile

import (
	"context"
	"log/slog"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/blobs"
	"mimoza-relay/internal/circles"
)

type store interface {
	GetProfile(ctx context.Context, accountID string) (accounts.Profile, error)
	SetProfile(ctx context.Context, accountID, name string) error
	SetProfilePicture(ctx context.Context, accountID, pictureID string) error
	SetPublicKey(ctx context.Context, accountID string, publicKey []byte) error
}

// memberships is the circles column's side of a change to the account
// that every circle it is in has to hear about. A replaced keypair flags
// each membership so the next member to sync reseals the content keys;
// a changed picture only moves each roster version, so the other devices
// refetch the roster and see the new id.
type memberships interface {
	MarkMembershipsNeedRewrap(ctx context.Context, accountID string) ([]string, error)
	TouchMemberships(ctx context.Context, accountID string) ([]string, error)
}

// bucket holds the picture. It is the one object in the bucket the relay
// can read: see accounts.Profile.
type bucket interface {
	UploadTarget(ctx context.Context, key string, maxBytes int64) (blobs.UploadTarget, error)
	Delete(ctx context.Context, key string) error
}

// maxPictureSize caps one picture, far below what a photo is allowed.
const maxPictureSize = 512 * 1024

type Service struct {
	Store store
	// Circles is what turns a new public key into a repair, and a new
	// picture into a roster everyone refetches. Without it a replaced key
	// would leave every circle unreadable with nothing asking anyone to
	// fix it.
	Circles memberships
	// Notify wakes the other members so one of them reseals, or so they
	// pick up the new picture. Without it a recovering device waits for
	// someone to open the app.
	Notify circles.Notifier
	// Blobs is nil in tests that do not care about bytes.
	Blobs bucket
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

// PictureUploadTarget is where an account sends its own picture. The key
// carries the account, so nobody can write a picture into anyone else's
// prefix, and a fresh id so an existing one is never overwritten.
func (s *Service) PictureUploadTarget(ctx context.Context, accountID, pictureID string) (blobs.UploadTarget, error) {
	return s.Blobs.UploadTarget(ctx, accounts.ProfilePictureKey(accountID, pictureID), maxPictureSize)
}

// SetPicture records the picture this account now shows, or clears it
// when pictureID is empty. The old one is retired, and every circle the
// account is in is told, since their rosters carry the id.
func (s *Service) SetPicture(ctx context.Context, accountID, pictureID string) (accounts.Profile, error) {
	previous, err := s.Store.GetProfile(ctx, accountID)
	if err != nil {
		return accounts.Profile{}, err
	}
	if err := s.Store.SetProfilePicture(ctx, accountID, pictureID); err != nil {
		return accounts.Profile{}, err
	}
	s.retirePicture(ctx, accountID, previous.ProfilePictureID, pictureID)
	if err := s.announcePicture(ctx, accountID); err != nil {
		return accounts.Profile{}, err
	}
	return s.Store.GetProfile(ctx, accountID)
}

// retirePicture deletes the picture a new one replaced. It runs after
// the row is written, so a failure leaves bytes nothing points at — and
// a signed URL for them still works until they are gone, which is why
// the read side checks the id against the profile rather than trusting
// the path.
func (s *Service) retirePicture(ctx context.Context, accountID, previous, current string) {
	if s.Blobs == nil || previous == "" || previous == current {
		return
	}
	if err := s.Blobs.Delete(ctx, accounts.ProfilePictureKey(accountID, previous)); err != nil {
		slog.ErrorContext(ctx, "replaced a profile picture but did not delete the old one",
			"reason", "picture_not_deleted", "error", err, "accountId", accountID, "pictureId", previous)
	}
}

// announcePicture moves every roster this account is on and wakes the
// members, so their devices refetch and see the new id. Nothing in the
// accounts table alone would make them look: a roster is refetched when
// its version moves, and that version lives on the circle.
func (s *Service) announcePicture(ctx context.Context, accountID string) error {
	if s.Circles == nil {
		return nil
	}
	touched, err := s.Circles.TouchMemberships(ctx, accountID)
	if err != nil {
		return err
	}
	if s.Notify != nil {
		for _, circleID := range touched {
			s.Notify.Notify(ctx, circles.Notification{
				Kind: circles.NotifyRoster, CircleID: circleID, ActorID: accountID,
			})
		}
	}
	return nil
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
