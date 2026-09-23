package circles

import "time"

// Roles. An admin invites, approves, removes and renames; everyone can
// post, comment and react.
const (
	RoleAdmin  = "admin"
	RoleMember = "member"
)

// What a member wants to be told about, most to least.
const (
	NotifyAll      = "all"      // posts, comments, reactions
	NotifyComments = "comments" // posts and comments
	NotifyPhotos   = "photos"   // posts only
	NotifyNone     = "none"
)

// MaxMembers caps a circle so removing a member — which reseals the new
// content key to everyone left — stays inside one DynamoDB transaction.
const MaxMembers = 50

// Member is one account's membership of one circle.
type Member struct {
	AccountID   string
	Role        string
	NotifyLevel string
	// NeedsRewrap means this account replaced its keypair, so its sealed
	// keys are unreadable until another member reseals them.
	NeedsRewrap bool
	// AvatarID is this member's picture in this circle, and AvatarKeyVersion
	// the content key it was sealed under. A picture is circle content
	// like a photo, so the same face is stored once per circle rather
	// than once per account.
	AvatarID         string
	AvatarKeyVersion int64
	JoinedAt         time.Time
}

func (m Member) IsAdmin() bool { return m.Role == RoleAdmin }

// SealedKeys is one member's copy of every content key version, each
// sealed to their account public key. The relay stores and hands these
// back; only the member can open them.
type SealedKeys map[int64][]byte

// Membership is one row of the caller's circle list: the circle, plus
// what this account's own
// membership says about it.
type Membership struct {
	Circle      Circle
	Role        string
	NotifyLevel string
	NeedsRewrap bool
}
