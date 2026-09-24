package erase

import (
	"testing"

	"mimoza-relay/internal/circles"
)

// circlesOf and the later ListMembers read are two separate queries, so
// accountID can already be gone from the roster by the time this runs —
// a bare member count cannot tell that apart from a genuine one-member
// circle that happens to be someone else's.
func TestTakesWholeCircle(t *testing.T) {
	cases := []struct {
		name      string
		roster    []circles.Member
		accountID string
		want      bool
	}{
		{"already gone, roster empty", nil, "gone-1", true},
		{"the sole member being erased", []circles.Member{{AccountID: "solo"}}, "solo", true},
		{
			"one other member remains, this account already removed",
			[]circles.Member{{AccountID: "other"}}, "erased-1", false,
		},
		{
			"several members remain",
			[]circles.Member{{AccountID: "erased-1"}, {AccountID: "other"}}, "erased-1", false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := takesWholeCircle(c.roster, c.accountID); got != c.want {
				t.Errorf("takesWholeCircle(%+v, %q) = %v, want %v", c.roster, c.accountID, got, c.want)
			}
		})
	}
}
