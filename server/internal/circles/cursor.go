package circles

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// Rewind is how far back a sync starts reading, before its first page.
// A post is stamped when its write is handled, not when it commits, so a
// slower write can land behind a cursor that has already moved past its
// stamp — measured at 9 of 20 on a burst of concurrent posts (see
// dynamodb/spike_test.go). Rewinding picks those up; the count in
// CountEntries catches whatever lands behind even this.
const Rewind = 30 * time.Second

// Cursor directions.
const (
	Forward  = "fwd"
	Backward = "back"
)

// cursorVersion is carried in every cursor so the encoding can change
// without breaking a device that stored one. Only this package reads a
// cursor; to a client it is an opaque string.
const cursorVersion = 1

// Cursor is a position in one entry stream. The zero Cursor starts a
// stream: the newest page, for a device that has nothing yet.
type Cursor struct {
	Type string
	At   time.Time
	// ID breaks ties inside one millisecond, so a page boundary neither
	// repeats a row nor skips one.
	ID        string
	Direction string
	// Continuing is set on the cursor that comes back from a full page.
	// It means "the next page of this same read", which resumes exactly
	// after the last row rather than rewinding.
	Continuing bool
}

func (c Cursor) IsZero() bool { return c.At.IsZero() && c.ID == "" }

type wireCursor struct {
	Version   int    `json:"v"`
	Type      string `json:"type"`
	At        int64  `json:"t"`
	ID        string `json:"id,omitempty"`
	Direction string `json:"d"`
	Cont      bool   `json:"c,omitempty"`
}

// Encode renders a cursor for a client to hold and hand back. Not signed:
// a forged cursor only reaches entries the caller may already read.
func (c Cursor) Encode() string {
	if c.IsZero() {
		return ""
	}
	raw, err := json.Marshal(wireCursor{
		Version:   cursorVersion,
		Type:      c.Type,
		At:        c.At.UnixMilli(),
		ID:        c.ID,
		Direction: c.Direction,
		Cont:      c.Continuing,
	})
	if err != nil {
		// Every field is a string, an int or a bool.
		panic(fmt.Sprintf("circles: cursor is unmarshalable: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

// ParseCursor reads one back. An empty string is the zero Cursor, which
// starts a stream rather than failing — that is what a first request
// sends.
func ParseCursor(encoded, entryType string) (Cursor, error) {
	if encoded == "" {
		return Cursor{Type: entryType}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return Cursor{}, ErrBadCursor
	}
	var wire wireCursor
	if err := json.Unmarshal(raw, &wire); err != nil {
		return Cursor{}, ErrBadCursor
	}
	if wire.Version != cursorVersion {
		return Cursor{}, ErrBadCursor
	}
	if wire.Direction != Forward && wire.Direction != Backward {
		return Cursor{}, ErrBadCursor
	}
	// A cursor belongs to the stream it was handed out for; using one
	// against another would silently read from the wrong position.
	if wire.Type != entryType {
		return Cursor{}, ErrBadCursor
	}
	return Cursor{
		Type:       wire.Type,
		At:         time.UnixMilli(wire.At),
		ID:         wire.ID,
		Direction:  wire.Direction,
		Continuing: wire.Cont,
	}, nil
}

// Position is where a read starts in the index: the sort-key value to
// read after (forward) or before (backward). A cursor that is not
// continuing a page run is the start of a sync, so it rewinds.
func (c Cursor) Position() string {
	if c.Direction == Forward && !c.Continuing {
		// The id breaks ties at c.At, and means nothing at an earlier
		// time: carrying it would exclude entries at exactly the rewound
		// moment whose ids sort below it.
		return IndexKey(c.Type, c.At.Add(-Rewind), "")
	}
	return IndexKey(c.Type, c.At, c.ID)
}

// IndexKey is the sort key of both entry indexes: the type, the time
// zero-padded so string order is time order, and the entry id to break
// ties. Padding is 13 digits — milliseconds stay 13 digits until the year
// 2286, and a shorter value would sort as smaller than a longer one.
func IndexKey(entryType string, at time.Time, id string) string {
	if id == "" {
		return fmt.Sprintf("%s#%013d", entryType, at.UnixMilli())
	}
	return fmt.Sprintf("%s#%013d#%s", entryType, at.UnixMilli(), id)
}

// TypePrefix is every key of one entry type, for a count or a full walk.
func TypePrefix(entryType string) string { return entryType + "#" }

// Advance returns the cursor to hand back after a page: resuming exactly
// after the last row, and continuing only while pages stay full, since a
// short page means the next read belongs to a later sync.
func (c Cursor) Advance(last Entry, full bool) Cursor {
	at := last.ReceivedAt
	if c.Type == TypePost && c.Direction == Forward {
		at = last.UpdatedAt
	}
	return Cursor{
		Type:       c.Type,
		At:         at,
		ID:         last.ID,
		Direction:  c.Direction,
		Continuing: full,
	}
}
