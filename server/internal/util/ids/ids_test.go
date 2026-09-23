package ids_test

import (
	"strings"
	"testing"

	"mimoza-relay/internal/util/ids"
)

func TestValid(t *testing.T) {
	for _, id := range []string{
		"post-1",
		"a3f0c2",
		strings.Repeat("a", ids.MaxLength),
		"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		"content_hash.v2",
	} {
		if !ids.Valid(id) {
			t.Errorf("expected %q to be accepted", id)
		}
	}

	// A slash would carry an id into another circle's prefix; a leading
	// dot and an empty id are both nothing a hash ever looks like.
	for _, id := range []string{
		"",
		"..",
		".hidden",
		"with/slash",
		"with space",
		"with\x00null",
		"../../etc/passwd",
		strings.Repeat("a", ids.MaxLength+1),
	} {
		if ids.Valid(id) {
			t.Errorf("expected %q to be refused", id)
		}
	}
}
