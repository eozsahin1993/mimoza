package integration_test

import (
	"encoding/base64"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// A profile picture is the account's, stored as uploaded: like the name,
// it is shown to people who hold no circle key yet — an admin answering
// a join request, someone opening an invite — so it cannot be sealed to
// anything. One picture per account, a fresh id per change, and three
// gated ways to fetch it, each resting on a relationship the relay can
// check.
func TestProfilePictures_OnePerAccountReplacedByID(t *testing.T) {
	relay := harness.Start(t)
	device := relay.SignIn()

	first := pictureTarget(t, device, "pic-1")
	harness.PostBlob(t, first.URL, first.Fields, []byte("first face"))
	var profile struct {
		ProfilePictureID string `json:"profilePictureId"`
	}
	device.Put(api("/account/picture"), harness.Body{"pictureId": "pic-1"}).Expect(http.StatusOK).Decode(&profile)
	harness.AssertEqual(t, profile.ProfilePictureID, "pic-1", "the profile names the picture")
	device.Get(api("/account")).Expect(http.StatusOK).Decode(&profile)
	harness.AssertEqual(t, profile.ProfilePictureID, "pic-1", "and reads it back")

	// The key is written once: a retry of the same id is told it landed.
	device.Post(api("/account/picture/pic-1/upload-target"), nil).Expect(http.StatusConflict)
	device.Post(api("/account/picture/../escape/upload-target"), nil).Expect(http.StatusNotFound)
	device.Put(api("/account/picture"), harness.Body{"pictureId": "not valid!"}).Expect(http.StatusBadRequest)

	// A new picture is a new id, and the old bytes are retired.
	admin := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, device, circleID)
	oldURL := memberPictureURL(t, admin, circleID, device.AccountID(), "pic-1")
	harness.AssertEqual(t, fetchStatus(t, oldURL), http.StatusOK, "the first picture is there")

	second := pictureTarget(t, device, "pic-2")
	harness.PostBlob(t, second.URL, second.Fields, []byte("second face"))
	device.Put(api("/account/picture"), harness.Body{"pictureId": "pic-2"}).Expect(http.StatusOK).Decode(&profile)
	harness.AssertEqual(t, profile.ProfilePictureID, "pic-2", "the replacement took")
	harness.AssertEqual(t, fetchStatus(t, oldURL), http.StatusNotFound, "and the old bytes are gone")
	harness.AssertEqual(t, string(fetch(t, memberPictureURL(t, admin, circleID, device.AccountID(), "pic-2"))),
		"second face", "a member fetches the new one")
	// A stale id is refused rather than signed.
	admin.Get(api("/circles/" + circleID + "/blobs/picture/" + device.AccountID() + "/pic-1")).Expect(http.StatusNotFound)

	// Clearing takes it away everywhere. A fresh struct for the decode:
	// profilePictureId is omitempty, so a cleared response simply omits
	// it, and decoding into the one above would leave pic-2 sitting there
	// unchanged rather than prove anything was cleared.
	var cleared struct {
		ProfilePictureID string `json:"profilePictureId"`
	}
	device.Delete(api("/account/picture")).Expect(http.StatusOK).Decode(&cleared)
	harness.AssertEqual(t, cleared.ProfilePictureID, "", "cleared")
	admin.Get(api("/circles/" + circleID + "/blobs/picture/" + device.AccountID() + "/pic-2")).Expect(http.StatusNotFound)
}

// The roster is how a member learns someone's picture changed: it
// carries the id, and a change moves the roster version so devices
// refetch.
func TestProfilePictures_AChangeMovesEveryRoster(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	var before struct {
		Circles []struct {
			CircleID      string `json:"circleId"`
			RosterVersion int64  `json:"rosterVersion"`
		} `json:"circles"`
	}
	admin.Get(api("/circles")).Expect(http.StatusOK).Decode(&before)

	target := pictureTarget(t, member, "pic-1")
	harness.PostBlob(t, target.URL, target.Fields, []byte("face"))
	member.Put(api("/account/picture"), harness.Body{"pictureId": "pic-1"}).Expect(http.StatusOK)

	var after struct {
		Circles []struct {
			CircleID      string `json:"circleId"`
			RosterVersion int64  `json:"rosterVersion"`
		} `json:"circles"`
	}
	admin.Get(api("/circles")).Expect(http.StatusOK).Decode(&after)
	harness.AssertTrue(t, after.Circles[0].RosterVersion > before.Circles[0].RosterVersion,
		"roster version %d should have moved past %d", after.Circles[0].RosterVersion, before.Circles[0].RosterVersion)

	var roster struct {
		Members []struct {
			AccountID        string `json:"accountId"`
			ProfilePictureID string `json:"profilePictureId"`
		} `json:"members"`
	}
	admin.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&roster)
	found := ""
	for _, entry := range roster.Members {
		if entry.AccountID == member.AccountID() {
			found = entry.ProfilePictureID
		}
	}
	harness.AssertEqual(t, found, "pic-1", "the roster carries the id")
}

// Before anyone shares a circle: an admin sees the face of someone asking
// in, and someone holding a code sees the face of whoever made it — both
// as a signed URL already inside the response, with no second relay call
// needed to get one.
func TestProfilePictures_AreSeenAcrossAnInvite(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	asker := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	adminTarget := pictureTarget(t, admin, "admin-pic")
	harness.PostBlob(t, adminTarget.URL, adminTarget.Fields, []byte("admin face"))
	admin.Put(api("/account/picture"), harness.Body{"pictureId": "admin-pic"}).Expect(http.StatusOK)
	askerTarget := pictureTarget(t, asker, "asker-pic")
	harness.PostBlob(t, askerTarget.URL, askerTarget.Fields, []byte("asker face"))
	asker.Put(api("/account/picture"), harness.Body{"pictureId": "asker-pic"}).Expect(http.StatusOK)

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)

	// The invitee's side: the preview carries a signed URL for the
	// inviter's picture directly, readable by anyone signed in.
	var preview struct {
		InvitedBy         string `json:"invitedBy"`
		ProfilePictureURL string `json:"profilePictureUrl"`
	}
	asker.Get(api("/invites/" + invite.Code)).Expect(http.StatusOK).Decode(&preview)
	harness.AssertEqual(t, string(fetch(t, preview.ProfilePictureURL)), "admin face", "the preview's url fetches the inviter's picture")
	relay.Anon().Get(api("/invites/" + invite.Code)).Expect(http.StatusUnauthorized)

	// The admin's side: each pending ask carries a signed URL for the
	// asker's picture the same way, and only an admin can list asks at
	// all, so that gate already covers the picture too.
	var request struct {
		RequestID string `json:"requestId"`
	}
	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&request)
	var pending struct {
		Requests []struct {
			ProfilePictureURL string `json:"profilePictureUrl"`
		} `json:"requests"`
	}
	admin.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusOK).Decode(&pending)
	harness.AssertEqual(t, string(fetch(t, pending.Requests[0].ProfilePictureURL)), "asker face", "the ask's url fetches the asker's picture")
	member.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusForbidden)

	// Revoked, the code opens nothing — preview included.
	admin.Delete(api("/circles/" + circleID + "/invites/" + invite.Code)).Expect(http.StatusNoContent)
	asker.Get(api("/invites/" + invite.Code)).Expect(http.StatusNotFound)
}

// Nobody outside a circle is handed a member's picture through it, and
// the per-circle avatar routes this replaced are gone.
func TestProfilePictures_TheGatesHold(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	outsider := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	target := pictureTarget(t, member, "pic-1")
	harness.PostBlob(t, target.URL, target.Fields, []byte("face"))
	member.Put(api("/account/picture"), harness.Body{"pictureId": "pic-1"}).Expect(http.StatusOK)

	outsider.Get(api("/circles/" + circleID + "/blobs/picture/" + member.AccountID() + "/pic-1")).Expect(http.StatusForbidden)
	admin.Get(api("/circles/" + circleID + "/blobs/picture/" + outsider.AccountID() + "/pic-1")).Expect(http.StatusForbidden)
	relay.Anon().Get(api("/circles/" + circleID + "/blobs/picture/" + member.AccountID() + "/pic-1")).Expect(http.StatusUnauthorized)
	relay.Anon().Post(api("/account/picture/pic-9/upload-target"), nil).Expect(http.StatusUnauthorized)

	member.Post(api("/circles/"+circleID+"/blobs/avatar/x/upload-target"), nil).Expect(http.StatusNotFound)
	admin.Get(api("/circles/" + circleID + "/blobs/avatar/" + member.AccountID() + "/x")).Expect(http.StatusNotFound)
	member.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"avatarId": "x", "keyVersion": 1,
	}).Expect(http.StatusBadRequest)
}

// Deleting the account takes the picture with it: nothing names the
// account any more, and its prefix is swept.
func TestProfilePictures_GoWithTheAccount(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	target := pictureTarget(t, member, "pic-1")
	harness.PostBlob(t, target.URL, target.Fields, []byte("face"))
	member.Put(api("/account/picture"), harness.Body{"pictureId": "pic-1"}).Expect(http.StatusOK)
	url := memberPictureURL(t, admin, circleID, member.AccountID(), "pic-1")
	harness.AssertEqual(t, fetchStatus(t, url), http.StatusOK, "there while the account is")

	member.Delete(api("/account")).Expect(http.StatusOK)
	harness.AssertEqual(t, fetchStatus(t, url), http.StatusNotFound, "and gone with it")

	var roster struct {
		Members []struct {
			AccountID string `json:"accountId"`
		} `json:"members"`
	}
	admin.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&roster)
	for _, entry := range roster.Members {
		harness.AssertTrue(t, entry.AccountID != member.AccountID(), "the deleted account is off the roster")
	}
	_ = base64.StdEncoding
}

func pictureTarget(t *testing.T, device *harness.Device, pictureID string) struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
} {
	t.Helper()
	var target struct {
		URL    string            `json:"url"`
		Fields map[string]string `json:"fields"`
	}
	device.Post(api("/account/picture/"+pictureID+"/upload-target"), nil).Expect(http.StatusOK).Decode(&target)
	return target
}

// memberPictureURL is the signed URL a fellow member is handed.
func memberPictureURL(t *testing.T, device *harness.Device, circleID, accountID, pictureID string) string {
	t.Helper()
	var signed struct {
		URL string `json:"url"`
	}
	device.Get(api("/circles/" + circleID + "/blobs/picture/" + accountID + "/" + pictureID)).
		Expect(http.StatusOK).Decode(&signed)
	return signed.URL
}
