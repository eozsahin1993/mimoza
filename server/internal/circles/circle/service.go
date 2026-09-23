package circle

import (
	"context"

	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"mimoza-relay/internal/blobs"
	"time"

	"mimoza-relay/internal/circles"
)

// store is what this resource needs and nothing else, so a fake in a
// test is these methods and a later store method cannot widen what this
// slice can reach.
type store interface {
	CreateCircle(ctx context.Context, circle circles.Circle, founder circles.Member, sealed []byte) error
	ListMemberships(ctx context.Context, accountID string) ([]circles.Membership, error)
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	UpdateCircle(ctx context.Context, circleID, name, coverID string, coverKeyVersion int64, actorID string) (circles.Circle, error)
	DeleteCircle(ctx context.Context, circleID string) error
}

// joinRequests is the asks this account has made, which are not
// memberships and are not in this slice's own rows. A device waiting to
// be let in learns here that it was admitted or turned down.
type joinRequests interface {
	ListRequestsForAccount(ctx context.Context, accountID string) ([]circles.Request, error)
}

// Pending is one ask, with the name of the circle it was made to: the
// asker is not a member, so nothing else would tell them what they are
// waiting on.
type Pending struct {
	circles.Request
	CircleName string
}

// bucket holds the cover and, under the same prefix, every photo posted
// to the circle.
type bucket interface {
	UploadTarget(ctx context.Context, key string, maxBytes int64) (blobs.UploadTarget, error)
	DownloadURL(ctx context.Context, key string) (string, error)
	DeletePrefix(ctx context.Context, prefix string) error
}

type Service struct {
	Store store
	// Blobs is nil in tests that do not care about bytes.
	Blobs bucket
	// Requests is what turns "no circles yet" into "waiting on Family".
	Requests joinRequests
}

// Create mints the circle id rather than taking one: it is the relay's
// key space, and a client-chosen id could collide with a circle the
// caller is not in.
func (s *Service) Create(ctx context.Context, accountID, name string, sealed []byte) (circles.Circle, circles.Member, error) {
	circle := circles.Circle{
		ID:            newID(),
		Name:          name,
		KeyVersion:    1,
		RosterVersion: 1,
		CreatedBy:     accountID,
		CreatedAt:     time.Now(),
	}
	founder := circles.Member{
		AccountID:   accountID,
		Role:        circles.RoleAdmin,
		NotifyLevel: circles.NotifyAll,
	}
	if err := s.Store.CreateCircle(ctx, circle, founder, sealed); err != nil {
		return circles.Circle{}, circles.Member{}, err
	}
	// The founder goes back too: the device that just made this circle
	// applies the membership rather than assuming what the relay chose.
	return circle, founder, nil
}

func newID() string {
	buf := make([]byte, 16)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// requireAdmin is the check every write in this slice starts with: the
// caller is in the circle, and is an admin of it.
func (s *Service) requireAdmin(ctx context.Context, circleID, accountID string) error {
	member, err := s.Store.GetMember(ctx, circleID, accountID)
	if err != nil {
		return err
	}
	if !member.IsAdmin() {
		return circles.ErrNotAdmin
	}
	return nil
}

// Patch sets the name, the cover, or both. A new cover is a new id, so
// its bytes sit at a key nothing has cached.
func (s *Service) Patch(ctx context.Context, circleID, accountID, name, coverID string, coverKeyVersion int64) (circles.Circle, error) {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return circles.Circle{}, err
	}
	if coverID != "" {
		circle, err := s.Store.GetCircle(ctx, circleID)
		if err != nil {
			return circles.Circle{}, err
		}
		if coverKeyVersion != circle.KeyVersion {
			return circles.Circle{}, circles.ErrStaleKeyVersion
		}
	}
	return s.Store.UpdateCircle(ctx, circleID, name, coverID, coverKeyVersion, accountID)
}

// Delete ends a circle for everyone in it.
func (s *Service) Delete(ctx context.Context, circleID, accountID string) error {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return err
	}
	if err := s.Store.DeleteCircle(ctx, circleID); err != nil {
		return err
	}
	// The rows are already gone, so a failure here leaves bytes nothing
	// can name.
	if s.Blobs == nil {
		return nil
	}
	if err := s.Blobs.DeletePrefix(ctx, blobPrefix(circleID)); err != nil {
		slog.ErrorContext(ctx, "deleted a circle but not its photos",
			"reason", "blobs_not_deleted", "error", err, "circleId", circleID)
	}
	return nil
}

// CoverUploadTarget is an admin's, matching the change that follows it:
// only an admin can point the circle at a new cover.
func (s *Service) CoverUploadTarget(ctx context.Context, circleID, coverID, accountID string) (blobs.UploadTarget, error) {
	if err := s.requireAdmin(ctx, circleID, accountID); err != nil {
		return blobs.UploadTarget{}, err
	}
	return s.Blobs.UploadTarget(ctx, coverKey(circleID, coverID), maxCoverSize)
}

// CoverURL has no row to check beyond membership: every change mints a
// new id.
func (s *Service) CoverURL(ctx context.Context, circleID, coverID, accountID string) (string, error) {
	if _, err := s.Store.GetMember(ctx, circleID, accountID); err != nil {
		return "", err
	}
	return s.Blobs.DownloadURL(ctx, coverKey(circleID, coverID))
}

// List is where a sync starts: every circle this account is in, with the
// versions a device checks its own against.
func (s *Service) List(ctx context.Context, accountID string) ([]circles.Membership, error) {
	return s.Store.ListMemberships(ctx, accountID)
}

// Waiting is the asks this account has made that have not expired,
// answered or not: an answered one stays until it expires, so the
// device that asked sees what the answer was rather than watching the
// ask disappear.
func (s *Service) Waiting(ctx context.Context, accountID string) ([]Pending, error) {
	if s.Requests == nil {
		return nil, nil
	}
	asks, err := s.Requests.ListRequestsForAccount(ctx, accountID)
	if err != nil {
		return nil, err
	}

	waiting := make([]Pending, 0, len(asks))
	for _, ask := range asks {
		// The circle is read one at a time because an account has one or
		// two asks outstanding, not a page of them.
		circle, err := s.Store.GetCircle(ctx, ask.CircleID)
		if err != nil {
			// A circle deleted while someone was waiting on it: the ask
			// is still theirs to see, it just has nothing to name.
			waiting = append(waiting, Pending{Request: ask})
			continue
		}
		waiting = append(waiting, Pending{Request: ask, CircleName: circle.Name})
	}
	return waiting, nil
}
