package circles

import "time"

// Entry types, plaintext because the relay routes and counts on them.
const (
	TypePost     = "post"
	TypeActivity = "activity"
)

// What an activity entry records. Written by the relay, in the same
// transaction as the change itself, so the wall and the roster can never
// disagree.
const (
	EventCreated        = "created"
	EventJoined         = "joined"
	EventLeft           = "left"
	EventRemoved        = "removed"
	EventAccountDeleted = "account_deleted"
	EventPromoted       = "promoted"
	EventDemoted        = "demoted"
	EventRenamed        = "renamed"
	EventCoverChanged   = "cover_changed"
)

// Entry is a post or an activity row. One shape rather than two because
// both are walked through the same index by the same cursor, and a client
// applies them from one stream.
type Entry struct {
	ID         string
	Type       string
	AuthorID   string
	ReceivedAt time.Time

	// Post only.
	KeyVersion     int64
	Ciphertext     []byte
	HasBlob        bool
	Visibility     string
	CommentCount   int64
	ReactionCounts map[string]int64
	RecentComments []Comment
	// IReacted is whether the reading member has reacted at all, and
	// ICommented whether they have commented. Both are read straight off
	// the post — it carries one entry per member who reacted or
	// commented, and a read projects only the caller's own — so the wall
	// needs no second query to show what you did.
	IReacted   bool
	ICommented bool
	UpdatedAt  time.Time
	DeletedAt  time.Time

	// Activity only.
	Event       string
	SubjectID   string
	SubjectName string
}

// Comment is one comment on a post. ParentCommentID is carried for
// replies and unused today.
type Comment struct {
	ID              string
	PostID          string
	AuthorID        string
	ParentCommentID string
	KeyVersion      int64
	Ciphertext      []byte
	ReceivedAt      time.Time
	DeletedAt       time.Time
}

// Reaction is one of a member's reactions to one post — a row per emoji,
// so changing it overwrites and the counts stay exact. Tag is
// HMAC(HKDF(contentKey), emoji): the relay counts by it and never learns
// which emoji it stands for.
type Reaction struct {
	AccountID  string
	PostID     string
	Tag        string
	KeyVersion int64
	Ciphertext []byte
	ReceivedAt time.Time
}

// Page is one read of an entry stream: what it found, and where to
// resume in either direction.
type Page struct {
	Entries []Entry
	Next    Cursor
	Prev    Cursor
	More    bool
}
