package integration_test

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// The whole of joining and posting, over HTTP against a real relay: an
// admin makes a circle, hands out a code, answers the ask it produces,
// and the two of them then see the same circle. Every step here is one
// a device actually makes, in the order it makes them.
func TestCircles_JoinAndPost(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	joiner := relay.SignIn()

	admin.Put(api("/account/profile"), harness.Body{"name": "Nadia"}).Expect(http.StatusOK)
	circleID := createCircle(t, admin, "Family")

	// The admin posts before anyone else is in, so the joiner's first
	// read has history to find.
	firstPost := putPost(t, admin, circleID, "post-1", 1)
	harness.AssertEqual(t, firstPost.AuthorID, admin.AccountID(), "the author is whoever is signed in")

	// A code, and what it shows to someone holding it.
	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)

	var preview struct {
		CircleID    string `json:"circleId"`
		Name        string `json:"name"`
		MemberCount int    `json:"memberCount"`
		InvitedBy   string `json:"invitedBy"`
	}
	joiner.Get(api("/invites/" + invite.Code)).Expect(http.StatusOK).Decode(&preview)
	harness.AssertEqual(t, preview.Name, "Family", "the preview names the circle")
	harness.AssertEqual(t, preview.MemberCount, 1, "the preview counts its members")
	// A person, not an account id: this is what the join sheet shows.
	harness.AssertEqual(t, preview.InvitedBy, "Nadia", "the preview names who shared the code")

	// Not a member yet: the circle's entries are not readable.
	joiner.Get(api("/circles/" + circleID + "/entries?type=post")).Expect(http.StatusForbidden)

	var request struct {
		RequestID string `json:"requestId"`
	}
	// No body: the key an approver seals to comes from the joiner's own
	// account, published when their device signed in.
	joiner.Post(api("/invites/"+invite.Code+"/requests"), nil).
		Expect(http.StatusCreated).Decode(&request)

	var pending struct {
		Requests []struct {
			RequestID string `json:"requestId"`
			PublicKey string `json:"publicKey"`
			Status    string `json:"status"`
		} `json:"requests"`
	}
	admin.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusOK).Decode(&pending)
	harness.AssertEqual(t, len(pending.Requests), 1, "the admin sees one ask")
	harness.AssertEqual(t, pending.Requests[0].Status, "pending", "and it is unanswered")
	// The joiner is not on the roster yet, so the ask is the only place
	// their key is published — without it there is nothing to seal to.
	harness.AssertEqual(t, pending.Requests[0].PublicKey,
		base64.StdEncoding.EncodeToString([]byte(joiner.AccountID()+"-public-key")),
		"the ask carries the key an approver seals to")

	// Approval carries every content key version, sealed to that key.
	admin.Post(api("/circles/"+circleID+"/requests/"+request.RequestID+"/approve"), harness.Body{
		"sealed": map[string]string{"1": base64.StdEncoding.EncodeToString([]byte("sealed-v1"))},
	}).Expect(http.StatusNoContent)

	// Now the joiner reads the history they were admitted to.
	posts := walk(t, joiner, circleID, "")
	harness.AssertEqual(t, len(posts.Entries), 1, "the joiner sees the post made before they arrived")
	harness.AssertEqual(t, posts.Entries[0].EntryID, "post-1", "and it is the one the admin wrote")

	// And they can write.
	putPost(t, joiner, circleID, "post-2", 1)

	// A roster names them both, and hands the caller their own keys.
	var roster struct {
		RosterVersion int64 `json:"rosterVersion"`
		Members       []struct {
			AccountID string `json:"accountId"`
			Role      string `json:"role"`
		} `json:"members"`
		Keys map[string]string `json:"keys"`
	}
	joiner.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&roster)
	harness.AssertEqual(t, len(roster.Members), 2, "both are on the roster")
	harness.AssertEqual(t, len(roster.Keys), 1, "the joiner got the key that was sealed to them")
}

// What a card shows about a post — its counts, the last comment, and
// what you yourself did — comes back on the post itself, so a wall needs
// no second call.
func TestCircles_APostCarriesWhatACardNeeds(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	putPost(t, admin, circleID, "post-1", 1)

	admin.Post(api("/circles/"+circleID+"/entries/post-1/comments"), harness.Body{
		"commentId":  "comment-1",
		"keyVersion": 1,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("nice one")),
	}).Expect(http.StatusCreated)

	admin.Put(api("/circles/"+circleID+"/entries/post-1/reactions/me"), harness.Body{
		"tag":        "tag-heart",
		"keyVersion": 1,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("heart")),
	}).Expect(http.StatusOK)

	posts := walk(t, admin, circleID, "")
	harness.AssertEqual(t, len(posts.Entries), 1, "one post")
	card := posts.Entries[0]
	harness.AssertEqual(t, card.CommentCount, int64(1), "the card counts the comment")
	harness.AssertEqual(t, len(card.RecentComments), 1, "and carries the last one")
	harness.AssertEqual(t, card.ReactionCounts["tag-heart"], int64(1), "and counts the reaction by tag")
	harness.AssertTrue(t, card.IReacted, "and says the caller has reacted")
	harness.AssertTrue(t, card.ICommented, "and that the caller has commented")

	// The details screen reads the children themselves.
	var children struct {
		Comments []struct {
			CommentID string `json:"commentId"`
		} `json:"comments"`
		Reactions []struct {
			AccountID string `json:"accountId"`
			Tag       string `json:"tag"`
		} `json:"reactions"`
	}
	admin.Get(api("/circles/" + circleID + "/entries/post-1/children")).Expect(http.StatusOK).Decode(&children)
	harness.AssertEqual(t, len(children.Comments), 1, "the comment is there in full")
	harness.AssertEqual(t, len(children.Reactions), 1, "and so is the reaction")
}

// A removed member loses the circle, and the rotation that removed them
// is what stops them reading anything written afterwards.
func TestCircles_RemovingAMemberRotatesTheKey(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	memberID := member.AccountID()
	admin.Post(api("/circles/"+circleID+"/members/"+memberID+"/remove"), harness.Body{
		"expectedVersion": 1,
		"sealed": map[string]string{
			admin.AccountID(): base64.StdEncoding.EncodeToString([]byte("sealed-v2")),
		},
	}).Expect(http.StatusNoContent)

	// Out: even reading is refused now.
	member.Get(api("/circles/" + circleID + "/entries?type=post")).Expect(http.StatusForbidden)

	// And the key moved, so the admin's next post is under version 2.
	var circle struct {
		KeyVersion int64 `json:"keyVersion"`
	}
	admin.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&circle)
	harness.AssertEqual(t, circle.KeyVersion, int64(2), "the key rotated on removal")

	admin.Post(api("/circles/"+circleID+"/entries"), harness.Body{
		"entryId":    "post-after",
		"keyVersion": 1,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("stale")),
	}).Expect(http.StatusConflict)
}

// The walk is what a device catches up with: it hands back where to
// resume, and resuming returns what arrived since.
func TestCircles_TheWalkResumesWhereItLeftOff(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	for i := range 3 {
		putPost(t, admin, circleID, fmt.Sprintf("post-%d", i), 1)
	}

	first := walk(t, admin, circleID, "")
	harness.AssertEqual(t, len(first.Entries), 3, "the first read returns what is there")
	harness.AssertTrue(t, first.Next != "", "and where to resume")

	// Resuming steps back 30 seconds before reading, so a sync that has
	// just caught up sees these again rather than nothing. That is the
	// contract: a device applies by entry id, so a repeat costs nothing
	// and a write that landed late is never missed.
	putPost(t, admin, circleID, "post-3", 1)
	after := walk(t, admin, circleID, first.Next)
	harness.AssertTrue(t, containsEntry(after, "post-3"), "resuming returns the post written since")

	// A short page is where a sync stops: more says so, and the cursor it
	// hands back belongs to the next sync, which starts by rewinding.
	harness.AssertTrue(t, !after.More, "a page shorter than the limit ends the walk")
}

// --- helpers ------------------------------------------------------------

func api(path string) string { return "/v1" + path }

type entryView struct {
	EntryID        string           `json:"entryId"`
	AuthorID       string           `json:"authorId"`
	Ciphertext     string           `json:"ciphertext"`
	DeletedAt      int64            `json:"deletedAt"`
	CommentCount   int64            `json:"commentCount"`
	ReactionCounts map[string]int64 `json:"reactionCounts"`
	RecentComments []struct {
		CommentID string `json:"commentId"`
	} `json:"recentComments"`
	IReacted   bool  `json:"iReacted"`
	ICommented bool  `json:"iCommented"`
	UpdatedAt  int64 `json:"updatedAt"`
}

type pageView struct {
	Entries []entryView `json:"entries"`
	Next    string      `json:"next"`
	Prev    string      `json:"prev"`
	More    bool        `json:"more"`
}

func createCircle(t *testing.T, device *harness.Device, name string) string {
	t.Helper()
	var created struct {
		CircleID string `json:"circleId"`
	}
	device.Post(api("/circles"), harness.Body{
		"name":      name,
		"sealedKey": base64.StdEncoding.EncodeToString([]byte("sealed-v1")),
	}).Expect(http.StatusCreated).Decode(&created)
	return created.CircleID
}

func putPost(t *testing.T, device *harness.Device, circleID, entryID string, keyVersion int64) entryView {
	t.Helper()
	var entry entryView
	device.Post(api("/circles/"+circleID+"/entries"), harness.Body{
		"entryId":    entryID,
		"keyVersion": keyVersion,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("ciphertext for " + entryID)),
	}).Expect(http.StatusCreated).Decode(&entry)
	return entry
}

func walk(t *testing.T, device *harness.Device, circleID, cursor string) pageView {
	t.Helper()
	path := api("/circles/" + circleID + "/entries?type=post")
	if cursor != "" {
		path += "&cursor=" + cursor
	}
	var page pageView
	device.Get(path).Expect(http.StatusOK).Decode(&page)
	return page
}

// joinCircle runs the whole handshake, for tests that need a second
// member rather than a test of joining itself.
func joinCircle(t *testing.T, admin, joiner *harness.Device, circleID string) {
	t.Helper()
	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)

	var request struct {
		RequestID string `json:"requestId"`
	}
	// No body: the key an approver seals to comes from the joiner's own
	// account, published when their device signed in.
	joiner.Post(api("/invites/"+invite.Code+"/requests"), nil).
		Expect(http.StatusCreated).Decode(&request)

	admin.Post(api("/circles/"+circleID+"/requests/"+request.RequestID+"/approve"), harness.Body{
		"sealed": map[string]string{"1": base64.StdEncoding.EncodeToString([]byte("sealed-v1"))},
	}).Expect(http.StatusNoContent)
}

// A device that has asked to join holds no membership yet, so the list
// it syncs against is also where it learns the answer.
func TestCircles_TheSyncListCarriesWhatYouAreWaitingOn(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	joiner := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)

	// Before asking: nothing to show, and no circles either.
	waiting := syncList(t, joiner)
	harness.AssertEqual(t, len(waiting.Circles), 0, "in no circles yet")
	harness.AssertEqual(t, len(waiting.Requests), 0, "and waiting on nothing")

	var request struct {
		RequestID string `json:"requestId"`
	}
	joiner.Post(api("/invites/"+invite.Code+"/requests"), nil).
		Expect(http.StatusCreated).Decode(&request)

	waiting = syncList(t, joiner)
	harness.AssertEqual(t, len(waiting.Requests), 1, "one ask outstanding")
	harness.AssertEqual(t, waiting.Requests[0].CircleID, circleID, "on the circle they asked about")
	harness.AssertEqual(t, waiting.Requests[0].CircleName, "Family", "named, though they cannot read it yet")
	harness.AssertEqual(t, waiting.Requests[0].Status, "pending", "and unanswered")

	// The answer reaches the asker through the same list.
	admin.Post(api("/circles/"+circleID+"/requests/"+request.RequestID+"/deny"), nil).Expect(http.StatusNoContent)
	waiting = syncList(t, joiner)
	harness.AssertEqual(t, len(waiting.Requests), 1, "the ask is still theirs to see")
	harness.AssertEqual(t, waiting.Requests[0].Status, "denied", "with the answer on it")
	harness.AssertEqual(t, len(waiting.Circles), 0, "and no circle")

	// Nobody else sees it.
	harness.AssertEqual(t, len(syncList(t, admin).Requests), 0, "an admin is not waiting on anything")
}

// syncList is GET /circles: the circles an account is in, and the asks
// it is waiting on.
func syncList(t *testing.T, device *harness.Device) struct {
	Circles  []circleRow `json:"circles"`
	Requests []struct {
		CircleID   string `json:"circleId"`
		CircleName string `json:"circleName"`
		Status     string `json:"status"`
	} `json:"requests"`
} {
	t.Helper()
	var body struct {
		Circles  []circleRow `json:"circles"`
		Requests []struct {
			CircleID   string `json:"circleId"`
			CircleName string `json:"circleName"`
			Status     string `json:"status"`
		} `json:"requests"`
	}
	device.Get(api("/circles")).Expect(http.StatusOK).Decode(&body)
	return body
}

func containsEntry(page pageView, entryID string) bool {
	for _, entry := range page.Entries {
		if entry.EntryID == entryID {
			return true
		}
	}
	return false
}
