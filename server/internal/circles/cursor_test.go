package circles_test

import (
	"errors"
	"testing"
	"time"

	"mimoza-relay/internal/circles"
)

func TestCursor_RoundTrips(t *testing.T) {
	at := time.UnixMilli(1758470400123)
	want := circles.Cursor{Type: circles.TypePost, At: at, ID: "post-1", Direction: circles.Forward, Continuing: true}

	got, err := circles.ParseCursor(want.Encode(), circles.TypePost)
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != want.Type || !got.At.Equal(want.At) || got.ID != want.ID ||
		got.Direction != want.Direction || got.Continuing != want.Continuing {
		t.Errorf("round trip lost something: %+v, want %+v", got, want)
	}
}

// A device holding no cursor is asking for the start of a stream, not
// making a mistake.
func TestParseCursor_EmptyStartsTheStream(t *testing.T) {
	got, err := circles.ParseCursor("", circles.TypeActivity)
	if err != nil {
		t.Fatal(err)
	}
	if !got.IsZero() || got.Type != circles.TypeActivity {
		t.Errorf("expected a zero cursor for activity, got %+v", got)
	}
}

func TestParseCursor_RejectsWhatItCannotTrust(t *testing.T) {
	valid := circles.Cursor{Type: circles.TypePost, At: time.Now(), ID: "post-1", Direction: circles.Forward}

	for _, tc := range []struct {
		name      string
		encoded   string
		entryType string
	}{
		{"not base64", "!!!!", circles.TypePost},
		{"not json", "aGVsbG8", circles.TypePost},
		{"another stream's cursor", valid.Encode(), circles.TypeActivity},
		{"a version this build does not know", `eyJ2Ijo5OSwidHlwZSI6InBvc3QiLCJ0IjoxLCJkIjoiZndkIn0`, circles.TypePost},
		{"no direction", `eyJ2IjoxLCJ0eXBlIjoicG9zdCIsInQiOjF9`, circles.TypePost},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := circles.ParseCursor(tc.encoded, tc.entryType); !errors.Is(err, circles.ErrBadCursor) {
				t.Errorf("expected ErrBadCursor, got %v", err)
			}
		})
	}
}

// The rewind belongs to the start of a sync. Applying it between pages
// would re-read rows the caller is still paging through.
func TestCursor_PositionRewindsOnlyAtTheStartOfASync(t *testing.T) {
	at := time.UnixMilli(1758470400000)

	start := circles.Cursor{Type: circles.TypePost, At: at, ID: "post-1", Direction: circles.Forward}
	if got, want := start.Position(), circles.IndexKey(circles.TypePost, at.Add(-circles.Rewind), "post-1"); got != want {
		t.Errorf("first read of a sync = %q, want %q", got, want)
	}

	next := start
	next.Continuing = true
	if got, want := next.Position(), circles.IndexKey(circles.TypePost, at, "post-1"); got != want {
		t.Errorf("next page = %q, want %q", got, want)
	}

	back := circles.Cursor{Type: circles.TypePost, At: at, ID: "post-1", Direction: circles.Backward}
	if got, want := back.Position(), circles.IndexKey(circles.TypePost, at, "post-1"); got != want {
		t.Errorf("backward read = %q, want %q", got, want)
	}
}

// Index keys are compared as strings, so the padding is what keeps time
// order intact across a digit boundary.
func TestIndexKey_SortsByTime(t *testing.T) {
	early := circles.IndexKey(circles.TypePost, time.UnixMilli(999), "z")
	late := circles.IndexKey(circles.TypePost, time.UnixMilli(1000), "a")
	if !(early < late) {
		t.Errorf("%q should sort before %q", early, late)
	}

	first := circles.IndexKey(circles.TypePost, time.UnixMilli(5), "post-1")
	second := circles.IndexKey(circles.TypePost, time.UnixMilli(5), "post-2")
	if !(first < second) {
		t.Errorf("same millisecond should break the tie by id: %q, %q", first, second)
	}
}

// A forward post cursor follows updatedAt, because that is the index it
// walks; everything else follows arrival.
func TestCursor_AdvanceFollowsTheIndexItWalks(t *testing.T) {
	received := time.UnixMilli(1000)
	updated := time.UnixMilli(2000)
	entry := circles.Entry{ID: "post-1", ReceivedAt: received, UpdatedAt: updated}

	forward := circles.Cursor{Type: circles.TypePost, Direction: circles.Forward}.Advance(entry, true)
	if !forward.At.Equal(updated) || forward.ID != "post-1" || !forward.Continuing {
		t.Errorf("forward posts should resume at updatedAt: %+v", forward)
	}

	backward := circles.Cursor{Type: circles.TypePost, Direction: circles.Backward}.Advance(entry, false)
	if !backward.At.Equal(received) || backward.Continuing {
		t.Errorf("backward posts should resume at receivedAt, not continuing: %+v", backward)
	}

	activity := circles.Cursor{Type: circles.TypeActivity, Direction: circles.Forward}.Advance(entry, true)
	if !activity.At.Equal(received) {
		t.Errorf("activity should resume at receivedAt: %+v", activity)
	}
}
