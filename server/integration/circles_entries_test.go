package integration_test

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// Removing a post is the author's, or an admin's. Nobody else can take
// down what someone else put up.
func TestCircles_DeletingAPostIsTheAuthorsOrAnAdmins(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	author := relay.SignIn()
	bystander := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, author, circleID)
	joinCircle(t, admin, bystander, circleID)

	putPost(t, author, circleID, "post-1", 1)
	putPost(t, author, circleID, "post-2", 1)

	bystander.Delete(api("/circles/" + circleID + "/entries/post-1")).Expect(http.StatusForbidden)
	author.Delete(api("/circles/" + circleID + "/entries/post-1")).Expect(http.StatusOK)
	admin.Delete(api("/circles/" + circleID + "/entries/post-2")).Expect(http.StatusOK)

	// The rows survive so the deletion reaches every device through the
	// same walk a post does — stripped, and marked.
	page := walk(t, bystander, circleID, "")
	harness.AssertEqual(t, len(page.Entries), 2, "both posts are still in the walk")
	for _, entry := range page.Entries {
		harness.AssertTrue(t, entry.DeletedAt > 0, "marked deleted")
		harness.AssertEqual(t, entry.Ciphertext, "", "and carrying nothing to read")
	}
}

// A comment belongs to whoever wrote it. The post's author has no say;
// an admin does.
func TestCircles_DeletingACommentIsTheCommentersOrAnAdmins(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	poster := relay.SignIn()
	commenter := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, poster, circleID)
	joinCircle(t, admin, commenter, circleID)
	putPost(t, poster, circleID, "post-1", 1)

	addComment(t, commenter, circleID, "post-1", "comment-1")

	// The post's author cannot remove someone else's comment.
	poster.Delete(api("/circles/" + circleID + "/entries/post-1/comments/comment-1")).Expect(http.StatusForbidden)

	var post entryView
	commenter.Delete(api("/circles/" + circleID + "/entries/post-1/comments/comment-1")).
		Expect(http.StatusOK).Decode(&post)
	harness.AssertEqual(t, post.CommentCount, int64(0), "the count follows the deletion")

	// Deleting it again must not subtract a second time.
	commenter.Delete(api("/circles/" + circleID + "/entries/post-1/comments/comment-1")).
		Expect(http.StatusOK).Decode(&post)
	harness.AssertEqual(t, post.CommentCount, int64(0), "a repeat changes nothing")
}

// The preview on a card is the newest comment, and it keeps up.
func TestCircles_ThePreviewFollowsTheNewestComment(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	putPost(t, admin, circleID, "post-1", 1)

	addComment(t, admin, circleID, "post-1", "comment-1")
	var post entryView
	admin.Post(api("/circles/"+circleID+"/entries/post-1/comments"), harness.Body{
		"commentId":  "comment-2",
		"keyVersion": 1,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("second")),
	}).Expect(http.StatusCreated).Decode(&post)

	harness.AssertEqual(t, post.CommentCount, int64(2), "both are counted")
	harness.AssertEqual(t, len(post.RecentComments), 1, "one is previewed")
	harness.AssertEqual(t, post.RecentComments[0].CommentID, "comment-2", "the newest")

	// Removing the newest falls back to what is left.
	admin.Delete(api("/circles/" + circleID + "/entries/post-1/comments/comment-2")).
		Expect(http.StatusOK).Decode(&post)
	harness.AssertEqual(t, len(post.RecentComments), 1, "the preview is rebuilt")
	harness.AssertEqual(t, post.RecentComments[0].CommentID, "comment-1", "from the survivor")
}

// Changing a reaction moves the count rather than adding one, and
// clearing it takes it away.
func TestCircles_AReactionIsASlotNotAnEvent(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	other := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, other, circleID)
	putPost(t, admin, circleID, "post-1", 1)

	react := func(device *harness.Device, tag string) entryView {
		t.Helper()
		var post entryView
		device.Put(api("/circles/"+circleID+"/entries/post-1/reactions/me"), harness.Body{
			"tag":        tag,
			"keyVersion": 1,
			"ciphertext": base64.StdEncoding.EncodeToString([]byte(tag)),
		}).Expect(http.StatusOK).Decode(&post)
		return post
	}

	react(admin, "tag-heart")
	post := react(admin, "tag-heart")
	harness.AssertEqual(t, post.ReactionCounts["tag-heart"], int64(1), "the same tag twice counts once")

	post = react(admin, "tag-laugh")
	harness.AssertEqual(t, post.ReactionCounts["tag-laugh"], int64(1), "changing moves the count")
	harness.AssertEqual(t, post.ReactionCounts["tag-heart"], int64(0), "off the old tag")

	post = react(other, "tag-laugh")
	harness.AssertEqual(t, post.ReactionCounts["tag-laugh"], int64(2), "each member counts separately")

	var cleared entryView
	admin.Delete(api("/circles/" + circleID + "/entries/post-1/reactions/me")).
		Expect(http.StatusOK).Decode(&cleared)
	harness.AssertEqual(t, cleared.ReactionCounts["tag-laugh"], int64(1), "clearing takes only the caller's")
	harness.AssertEqual(t, cleared.MyTag, "", "and they no longer have one")
}

// History pages backward in the order things were written, and the count
// is what tells a device whether it has all of them.
func TestCircles_HistoryPagesBackwardAndCounts(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	for i := range 5 {
		putPost(t, admin, circleID, fmt.Sprintf("post-%d", i), 1)
	}

	// Two at a time, walking back.
	seen := map[string]bool{}
	page := walkLimited(t, admin, circleID, "", 2)
	for range 5 {
		for _, entry := range page.Entries {
			seen[entry.EntryID] = true
		}
		if !page.More {
			break
		}
		page = walkLimited(t, admin, circleID, page.Prev, 2)
	}
	if len(seen) != 5 {
		ids := make([]string, 0, len(seen))
		for id := range seen {
			ids = append(ids, id)
		}
		t.Fatalf("paging back saw %d distinct entries: %v", len(seen), ids)
	}

	var counted struct {
		Count int64 `json:"count"`
	}
	admin.Get(api("/circles/" + circleID + "/entries?type=post&count=1")).
		Expect(http.StatusOK).Decode(&counted)
	harness.AssertEqual(t, counted.Count, int64(5), "the count agrees with what was walked")
}

// The wall's other stream: what happened to the circle itself.
func TestCircles_TheActivityStreamRecordsWhatHappened(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	admin.Patch(api("/circles/"+circleID), harness.Body{"name": "Renamed"}).Expect(http.StatusOK)
	admin.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"role": "admin",
	}).Expect(http.StatusNoContent)
	member.Post(api("/circles/"+circleID+"/leave"), nil).Expect(http.StatusNoContent)

	var stream struct {
		Entries []struct {
			Event string `json:"event"`
		} `json:"entries"`
	}
	admin.Get(api("/circles/" + circleID + "/entries?type=activity")).Expect(http.StatusOK).Decode(&stream)

	events := map[string]int{}
	for _, entry := range stream.Entries {
		events[entry.Event]++
	}
	for _, want := range []string{"created", "joined", "renamed", "promoted", "left"} {
		harness.AssertTrue(t, events[want] > 0, "the wall records %q", want)
	}
}

// A post encrypted under a key that has been rotated away would be
// unreadable to everyone but its author.
func TestCircles_WritesUnderAnOldKeyAreRefused(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)
	putPost(t, admin, circleID, "post-1", 1)

	admin.Post(api("/circles/"+circleID+"/members/"+member.AccountID()+"/remove"), harness.Body{
		"expectedVersion": 1,
		"sealed": map[string]string{
			admin.AccountID(): base64.StdEncoding.EncodeToString([]byte("v2")),
		},
	}).Expect(http.StatusNoContent)

	for _, call := range []struct {
		what string
		run  func() harness.Response
	}{
		{"a post", func() harness.Response {
			return admin.Post(api("/circles/"+circleID+"/entries"), harness.Body{
				"entryId": "post-2", "keyVersion": 1, "ciphertext": "eA==",
			})
		}},
		{"a comment", func() harness.Response {
			return admin.Post(api("/circles/"+circleID+"/entries/post-1/comments"), harness.Body{
				"commentId": "comment-1", "keyVersion": 1, "ciphertext": "eA==",
			})
		}},
		{"a reaction", func() harness.Response {
			return admin.Put(api("/circles/"+circleID+"/entries/post-1/reactions/me"), harness.Body{
				"tag": "tag-heart", "keyVersion": 1, "ciphertext": "eA==",
			})
		}},
	} {
		t.Run(call.what, func(t *testing.T) {
			call.run().Expect(http.StatusConflict)
		})
	}

	// Under the current version it lands.
	admin.Post(api("/circles/"+circleID+"/entries"), harness.Body{
		"entryId": "post-2", "keyVersion": 2, "ciphertext": "eA==",
	}).Expect(http.StatusCreated)
}

func addComment(t *testing.T, device *harness.Device, circleID, postID, commentID string) {
	t.Helper()
	device.Post(api("/circles/"+circleID+"/entries/"+postID+"/comments"), harness.Body{
		"commentId":  commentID,
		"keyVersion": 1,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("comment " + commentID)),
	}).Expect(http.StatusCreated)
}

func walkLimited(t *testing.T, device *harness.Device, circleID, cursor string, limit int) pageView {
	t.Helper()
	path := api(fmt.Sprintf("/circles/%s/entries?type=post&limit=%d", circleID, limit))
	if cursor != "" {
		path += "&cursor=" + cursor
	}
	var page pageView
	device.Get(path).Expect(http.StatusOK).Decode(&page)
	return page
}
