package integration_test

import (
	"encoding/base64"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// Who the caller is comes from the session, never from the path or the
// body. These are the cases where a client could otherwise name someone
// else and be believed.
func TestCircles_TheSessionIsTheIdentity(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	t.Run("a post is authored by whoever is signed in", func(t *testing.T) {
		var entry entryView
		member.Post(api("/circles/"+circleID+"/entries"), harness.Body{
			"entryId":    "post-claimed",
			"keyVersion": 1,
			"ciphertext": base64.StdEncoding.EncodeToString([]byte("x")),
			// A client cannot hand itself another author: the field is
			// not read, and the session decides.
			"authorId": admin.AccountID(),
		}).Expect(http.StatusCreated).Decode(&entry)
		harness.AssertEqual(t, entry.AuthorID, member.AccountID(), "the author is the caller")
	})

	t.Run("a reaction belongs to the caller, not a named account", func(t *testing.T) {
		var post entryView
		member.Put(api("/circles/"+circleID+"/entries/post-claimed/reactions/me"), harness.Body{
			"tag":        "tag-heart",
			"keyVersion": 1,
			"ciphertext": base64.StdEncoding.EncodeToString([]byte("h")),
			"accountId":  admin.AccountID(),
		}).Expect(http.StatusOK).Decode(&post)

		var children struct {
			Reactions []struct {
				AccountID string `json:"accountId"`
			} `json:"reactions"`
		}
		member.Get(api("/circles/" + circleID + "/entries/post-claimed/children")).
			Expect(http.StatusOK).Decode(&children)
		harness.AssertEqual(t, len(children.Reactions), 1, "one reaction")
		harness.AssertEqual(t, children.Reactions[0].AccountID, member.AccountID(), "and it is the caller's")
	})

	t.Run("the caller's own markers are their own", func(t *testing.T) {
		// The same post, read by two members: each is told what they did,
		// not what the other did.
		theirs := walk(t, member, circleID, "")
		harness.AssertTrue(t, containsEntry(theirs, "post-claimed"), "the post is in the walk")
		for _, entry := range theirs.Entries {
			if entry.EntryID == "post-claimed" {
				harness.AssertTrue(t, entry.IReacted, "the reactor sees their own filled state")
			}
		}

		others := walk(t, admin, circleID, "")
		for _, entry := range others.Entries {
			if entry.EntryID == "post-claimed" {
				harness.AssertTrue(t, !entry.IReacted, "someone who has not reacted sees none")
				harness.AssertEqual(t, entry.ReactionCounts["tag-heart"], int64(1), "but sees the count")
			}
		}
	})
}

// No session, no circle: every route refuses an anonymous caller before
// it looks at anything else.
func TestCircles_EveryRouteRequiresASession(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	putPost(t, admin, circleID, "post-1", 1)
	anon := relay.Anon()

	for _, call := range []struct {
		what string
		run  func() harness.Response
	}{
		{"list circles", func() harness.Response { return anon.Get(api("/circles")) }},
		{"create a circle", func() harness.Response {
			return anon.Post(api("/circles"), harness.Body{"name": "x", "sealedKey": "eA=="})
		}},
		{"read entries", func() harness.Response {
			return anon.Get(api("/circles/" + circleID + "/entries?type=post"))
		}},
		{"read the roster", func() harness.Response { return anon.Get(api("/circles/" + circleID + "/roster")) }},
		{"write a post", func() harness.Response {
			return anon.Post(api("/circles/"+circleID+"/entries"), harness.Body{
				"entryId": "x", "keyVersion": 1, "ciphertext": "eA==",
			})
		}},
		{"comment", func() harness.Response {
			return anon.Post(api("/circles/"+circleID+"/entries/post-1/comments"), harness.Body{
				"commentId": "c", "keyVersion": 1, "ciphertext": "eA==",
			})
		}},
		{"react", func() harness.Response {
			return anon.Put(api("/circles/"+circleID+"/entries/post-1/reactions/me"), harness.Body{
				"tag": "t", "keyVersion": 1, "ciphertext": "eA==",
			})
		}},
		{"make an invite", func() harness.Response { return anon.Post(api("/circles/"+circleID+"/invites"), nil) }},
		{"read an invite", func() harness.Response { return anon.Get(api("/invites/anything")) }},
		{"leave", func() harness.Response { return anon.Post(api("/circles/"+circleID+"/leave"), nil) }},
	} {
		t.Run(call.what, func(t *testing.T) {
			call.run().Expect(http.StatusUnauthorized)
		})
	}
}

// Approving is the admin's act, and the relay records who did it rather
// than taking the client's word for it.
func TestCircles_ApprovalIsRecordedAgainstTheAdminWhoDidIt(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	joiner := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, joiner, circleID)

	var activity struct {
		Entries []struct {
			Event       string `json:"event"`
			AuthorID    string `json:"authorId"`
			SubjectID   string `json:"subjectId"`
			SubjectName string `json:"subjectName"`
		} `json:"entries"`
	}
	joiner.Get(api("/circles/" + circleID + "/entries?type=activity")).Expect(http.StatusOK).Decode(&activity)

	var joined bool
	for _, entry := range activity.Entries {
		if entry.Event != "joined" {
			continue
		}
		joined = true
		harness.AssertEqual(t, entry.AuthorID, admin.AccountID(), "the admin who approved is the actor")
		harness.AssertEqual(t, entry.SubjectID, joiner.AccountID(), "and the joiner is the subject")
	}
	harness.AssertTrue(t, joined, "the join is on the wall")
}
