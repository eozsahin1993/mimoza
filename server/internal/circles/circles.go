// Package circles is the relay's own model of a circle: who is in it,
// what role they hold, the content key sealed to each of them, and the
// entries they write. Unlike synclog, which it replaces, this column
// knows membership — authorization is a row lookup here, not a
// capability the caller presents.
//
// What it still cannot read is content: a post's caption, a comment's
// text and a cover photo arrive as ciphertext under a key only members
// hold. See docs/RELAY_DESIGN.md.
package circles

import "time"

// Circle is the circle itself, without its members or entries.
type Circle struct {
	ID      string
	Name    string
	CoverID string
	// KeyVersion is the content key entries must be encrypted under; it
	// rises by one every time a member is removed.
	KeyVersion int64
	// RosterVersion rises on every membership, role or key change, so a
	// device can tell from the circle list alone whether to refetch the
	// roster.
	RosterVersion int64
	// LastEntryAt is a hint that something happened, not a completeness
	// check — see the count in docs/RELAY_DESIGN.md.
	LastEntryAt time.Time
	CreatedBy   string
	CreatedAt   time.Time
}
