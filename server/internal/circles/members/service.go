package members

import (
	"context"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type store interface {
	GetCircle(ctx context.Context, circleID string) (circles.Circle, error)
	GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error)
	ListMembers(ctx context.Context, circleID string) ([]circles.Member, error)
	GetSealedKeys(ctx context.Context, circleID, accountID string) (circles.SealedKeys, error)
	SetRole(ctx context.Context, circleID, accountID, role, actorID, subjectName string) error
	SetNotifyLevel(ctx context.Context, circleID, accountID, level string) error
	RemoveMember(ctx context.Context, circleID, accountID, actorID, subjectName string, expectedVersion int64, sealed map[string][]byte) error
	LeaveCircle(ctx context.Context, circleID, accountID, subjectName string, expectedVersion int64, sealed map[string][]byte) error
	ReplaceSealedKeys(ctx context.Context, circleID, accountID string, sealed circles.SealedKeys) error
}

// profiles is the accounts column's side of a roster: who these
// account ids are. The circles column stores memberships and never a
// name, so every screen that shows people joins the two here.
type profiles interface {
	GetProfile(ctx context.Context, accountID string) (accounts.Profile, error)
	GetProfiles(ctx context.Context, accountIDs []string) (map[string]accounts.Profile, error)
}

// bucket signs the one read this slice hands out: a member's profile
// picture, which lives under the account.
type bucket interface {
	DownloadURL(ctx context.Context, key string) (string, error)
}

// ender ends a circle whose last member has just left. The sweep lives
// in the circle slice; this is the one place outside it that needs one.
type ender interface {
	End(ctx context.Context, circleID string) error
}

type Service struct {
	Store store
	// Notify is nil in tests that do not care who hears about a change.
	Notify circles.Notifier
	// Blobs is nil in tests that do not care about bytes.
	Blobs bucket
	// Profiles fills in names, pictures and the public keys members seal
	// content keys to. A roster without them is a list of opaque ids.
	Profiles profiles
	// Circles ends one that has just emptied. Nil in tests that do not
	// care what happens to the rows afterwards.
	Circles ender
}

// RosterMember is one member with the person behind them: the
// membership from the circles column, the name, picture and public key
// from the accounts column.
type RosterMember struct {
	circles.Member
	Name string
	// ProfilePictureID is the picture the account currently shows, the
	// same in every circle. A device fetches it through
	// ProfilePictureURL once per id, whichever circle it learned it from.
	ProfilePictureID string
	// PublicKey is what this member's copy of a content key is sealed
	// to. It is on the roster because resealing after a kick or a reset
	// happens on another member's device, which needs every key here.
	PublicKey []byte
}

// Roster is the circle's members and the caller's own sealed keys: one
// call, because a device that has just learned the roster moved almost
// always needs both.
func (s *Service) Roster(ctx context.Context, circleID, accountID string) (circles.Circle, []RosterMember, circles.SealedKeys, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return circles.Circle{}, nil, nil, err
	}
	circle, err := s.Store.GetCircle(ctx, circleID)
	if err != nil {
		return circles.Circle{}, nil, nil, err
	}
	roster, err := s.Store.ListMembers(ctx, circleID)
	if err != nil {
		return circles.Circle{}, nil, nil, err
	}
	keys, err := s.Store.GetSealedKeys(ctx, circleID, accountID)
	if err != nil {
		return circles.Circle{}, nil, nil, err
	}

	ids := make([]string, 0, len(roster))
	for _, member := range roster {
		ids = append(ids, member.AccountID)
	}
	identities, err := s.Profiles.GetProfiles(ctx, ids)
	if err != nil {
		return circles.Circle{}, nil, nil, err
	}

	members := make([]RosterMember, 0, len(roster))
	for _, member := range roster {
		// A member with no profile is one whose account went in between
		// the two reads. They stay on the roster nameless rather than
		// disappearing from it, because the membership is what decides
		// who can read the circle.
		identity := identities[member.AccountID]
		members = append(members, RosterMember{
			Member:           member,
			Name:             identity.Name,
			ProfilePictureID: identity.ProfilePictureID,
			PublicKey:        identity.PublicKey,
		})
	}
	return circle, members, keys, nil
}

// SetRole is an admin's to make; SetNotifyLevel is only ever your own.
// Both arrive on the same route, so the rule is per field rather than
// per route.
func (s *Service) SetRole(ctx context.Context, circleID, subjectID, role, actorID string) error {
	if err := s.requireAdmin(ctx, circleID, actorID); err != nil {
		return err
	}
	if err := s.requireMember(ctx, circleID, subjectID); err != nil {
		return err
	}
	// Demoting the last admin would leave nobody able to rotate a key or
	// admit anyone ever again.
	if role == circles.RoleMember {
		if err := s.wouldStrandCircle(ctx, circleID, subjectID); err != nil {
			return err
		}
	}
	if err := s.Store.SetRole(ctx, circleID, subjectID, role, actorID, s.nameOf(ctx, subjectID)); err != nil {
		return err
	}
	s.wake(ctx, circleID, actorID)
	return nil
}

func (s *Service) SetNotifyLevel(ctx context.Context, circleID, subjectID, level, actorID string) error {
	if subjectID != actorID {
		return circles.ErrNotTheAuthor
	}
	return s.Store.SetNotifyLevel(ctx, circleID, subjectID, level)
}

// ProfilePictureURL is any member's to ask for about any other member:
// sharing a circle is what entitles you to see a face.
func (s *Service) ProfilePictureURL(ctx context.Context, circleID, subjectID, pictureID, accountID string) (string, error) {
	if err := s.requireMember(ctx, circleID, accountID); err != nil {
		return "", err
	}
	if err := s.requireMember(ctx, circleID, subjectID); err != nil {
		return "", err
	}
	profile, err := s.Profiles.GetProfile(ctx, subjectID)
	if err != nil || profile.ProfilePictureID == "" || profile.ProfilePictureID != pictureID {
		return "", circles.ErrPictureNotFound
	}
	return s.Blobs.DownloadURL(ctx, accounts.ProfilePictureKey(subjectID, pictureID))
}

// Remove takes a member out and rotates the content key. The caller
// supplies the new key sealed to everyone who stays; the store refuses
// anything that does not cover them all.
func (s *Service) Remove(ctx context.Context, circleID, subjectID, actorID string, expectedVersion int64, sealed map[string][]byte) error {
	if err := s.requireAdmin(ctx, circleID, actorID); err != nil {
		return err
	}
	if subjectID == actorID {
		// Removing yourself is leaving — call that instead.
		return circles.ErrNotTheAuthor
	}
	if err := s.Store.RemoveMember(ctx, circleID, subjectID, actorID, s.nameOf(ctx, subjectID), expectedVersion, sealed); err != nil {
		return err
	}
	s.wake(ctx, circleID, actorID)
	return nil
}

// Leave is never refused for long: the last admin has to hand the role
// on first, but nobody is held in a circle. Rotates the content key the
// same way Remove does — the caller supplies the new key sealed to
// everyone who stays.
func (s *Service) Leave(ctx context.Context, circleID, accountID string, expectedVersion int64, sealed map[string][]byte) error {
	if err := s.wouldStrandCircle(ctx, circleID, accountID); err != nil {
		return err
	}

	// The last one out takes the circle with them. Left standing, its
	// meta, entries and photos would be unreachable forever: nothing
	// lists a circle nobody is in, and DELETE /circles wants an admin
	// this account has just stopped being.
	roster, err := s.Store.ListMembers(ctx, circleID)
	if err != nil {
		return err
	}
	if len(roster) == 1 && roster[0].AccountID == accountID && s.Circles != nil {
		return s.Circles.End(ctx, circleID)
	}

	if err := s.Store.LeaveCircle(ctx, circleID, accountID, s.nameOf(ctx, accountID), expectedVersion, sealed); err != nil {
		return err
	}
	s.wake(ctx, circleID, accountID)
	return nil
}

// Rewrap is one member resealing the content keys to another member's
// new public key, after that member replaced their keypair. Any member
// may do it: they all hold the same keys, and the sealing happens on
// their device.
func (s *Service) Rewrap(ctx context.Context, circleID, subjectID, actorID string, sealed circles.SealedKeys) error {
	if err := s.requireMember(ctx, circleID, actorID); err != nil {
		return err
	}
	if err := s.requireMember(ctx, circleID, subjectID); err != nil {
		return err
	}
	// The whole map is replaced, so a missing version is not "left
	// alone", it is gone: every version this circle has ever had must be
	// in here, or the subject loses the history sealed under it.
	circle, err := s.Store.GetCircle(ctx, circleID)
	if err != nil {
		return err
	}
	for version := int64(1); version <= circle.KeyVersion; version++ {
		if len(sealed[version]) == 0 {
			return circles.ErrIncompleteKeys
		}
	}
	if err := s.Store.ReplaceSealedKeys(ctx, circleID, subjectID, sealed); err != nil {
		return err
	}
	// The member who was waiting to be let back in is the one who wants
	// to hear about this.
	if s.Notify != nil {
		s.Notify.Notify(ctx, circles.Notification{
			Kind: circles.NotifyRewrapped, CircleID: circleID,
			ActorID: actorID, Only: []string{subjectID},
		})
	}
	return nil
}

// wake is the silent push behind every roster change: a phone in a
// pocket syncs and sees the new roster, whatever it has silenced.
func (s *Service) wake(ctx context.Context, circleID, actorID string) {
	if s.Notify == nil {
		return
	}
	s.Notify.Notify(ctx, circles.Notification{
		Kind: circles.NotifyRoster, CircleID: circleID, ActorID: actorID,
	})
}

// nameOf is the name to stamp on the activity entry this change writes.
// It is copied rather than looked up later because the wall still has to
// say who left after they have gone, and a deleted account has no
// profile to ask. A failed read costs the name, not the change.
func (s *Service) nameOf(ctx context.Context, accountID string) string {
	profile, err := s.Profiles.GetProfile(ctx, accountID)
	if err != nil {
		return ""
	}
	return profile.Name
}

// wouldStrandCircle reports whether this account is the only admin left
// while others remain, which is the one case a departure or demotion has
// to refuse.
func (s *Service) wouldStrandCircle(ctx context.Context, circleID, accountID string) error {
	roster, err := s.Store.ListMembers(ctx, circleID)
	if err != nil {
		return err
	}
	admins, others := 0, 0
	for _, member := range roster {
		if member.IsAdmin() {
			admins++
		}
		if member.AccountID != accountID {
			others++
		}
	}
	self, err := s.Store.GetMember(ctx, circleID, accountID)
	if err != nil {
		return err
	}
	if self.IsAdmin() && admins == 1 && others > 0 {
		return circles.ErrWouldEmptyAdmins
	}
	return nil
}

// requireMember and requireAdmin are how every operation in this slice
// starts: they turn "who is calling" into the error a caller sees.
func (s *Service) requireMember(ctx context.Context, circleID, accountID string) error {
	_, err := s.Store.GetMember(ctx, circleID, accountID)
	return err
}

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
