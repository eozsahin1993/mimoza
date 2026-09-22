package circles

import "errors"

var (
	ErrCircleNotFound = errors.New("circles: no such circle")
	ErrAlreadyExists  = errors.New("circles: already exists")
	ErrNotMember      = errors.New("circles: not a member of this circle")
	ErrNotAdmin       = errors.New("circles: not an admin of this circle")
	ErrCircleFull     = errors.New("circles: this circle is full")
	// ErrStaleKeyVersion means the caller encrypted under a key that has
	// since been rotated away: fetch the current one and write again.
	ErrStaleKeyVersion = errors.New("circles: encrypted under an old key version")
	// ErrVersionMoved means the circle changed between the caller's read
	// and its write — another admin got there first. Re-read and retry.
	ErrVersionMoved  = errors.New("circles: circle changed concurrently")
	ErrEntryNotFound = errors.New("circles: no such entry")
	ErrNotTheAuthor  = errors.New("circles: not the author, and not an admin")
	// ErrIncompleteKeys means a write that reseals the content key did not
	// cover everyone it had to, which would leave a member unable to read.
	ErrIncompleteKeys   = errors.New("circles: sealed keys do not cover the roster")
	ErrWouldEmptyAdmins = errors.New("circles: a circle cannot be left without an admin")
	ErrInviteNotFound   = errors.New("circles: no such invite")
	ErrRequestNotFound  = errors.New("circles: no such join request")
	ErrBadCursor        = errors.New("circles: unreadable cursor")
	// ErrNoPublicKey means the account asking to join has published no
	// key to seal the circle's content keys to, so admitting it would
	// admit someone who could not read a word of the circle.
	ErrNoPublicKey = errors.New("circles: this account has published no public key")
)
