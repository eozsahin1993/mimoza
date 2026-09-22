package circles

import "time"

// DefaultInviteRetentionDays is how long a code lasts when nothing says
// otherwise, matching the client's own INVITE_TTL_MS.
const DefaultInviteRetentionDays = 7

// Invite is a live invite code.
type Invite struct {
	Code      string
	CircleID  string
	CreatedBy string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// Request statuses.
const (
	RequestPending  = "pending"
	RequestApproved = "approved"
	RequestDenied   = "denied"
)

// Request is someone asking to join, carrying the public key an approver
// seals the circle's keys to.
type Request struct {
	ID        string
	CircleID  string
	AccountID string
	PublicKey []byte
	Status    string
	CreatedAt time.Time
	ExpiresAt time.Time
}
