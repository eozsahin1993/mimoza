package integration_test

import (
	"encoding/base64"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// A picture is circle content, sealed under the circle's key like a
// photo, so the relay stores a face it cannot see. That is why the same
// person puts a copy in each circle they are in rather than keeping one
// on their account.
func TestCircleAvatars_APictureIsSealedToTheCircleItIsIn(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	outsider := relay.SignIn()
	member.Put(api("/account/profile"), harness.Body{"name": "Ali"}).Expect(http.StatusOK)

	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	target := circleAvatarTarget(t, member, circleID, "hash-1")
	harness.PostBlob(t, target.URL, target.Fields, []byte("sealed picture"))

	member.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"avatarId":   "hash-1",
		"keyVersion": 1,
	}).Expect(http.StatusNoContent)

	// The roster carries the picture beside the name, and says which key
	// version opens it.
	var roster struct {
		Members []struct {
			AccountID        string `json:"accountId"`
			Name             string `json:"name"`
			AvatarID         string `json:"avatarId"`
			AvatarKeyVersion int64  `json:"avatarKeyVersion"`
		} `json:"members"`
	}
	admin.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&roster)

	var found struct {
		id      string
		version int64
		name    string
	}
	for _, entry := range roster.Members {
		if entry.AccountID == member.AccountID() {
			found.id, found.version, found.name = entry.AvatarID, entry.AvatarKeyVersion, entry.Name
		}
	}
	harness.AssertEqual(t, found.id, "hash-1", "the roster carries the picture")
	harness.AssertEqual(t, found.version, int64(1), "and the key that opens it")
	harness.AssertEqual(t, found.name, "Ali", "beside the name, which the relay can read")

	var download struct {
		URL string `json:"url"`
	}
	admin.Get(api("/circles/" + circleID + "/blobs/avatar/" + member.AccountID() + "/hash-1")).
		Expect(http.StatusOK).Decode(&download)
	harness.AssertEqual(t, string(fetch(t, download.URL)), "sealed picture", "a member can fetch it")

	// Nobody outside the circle, in either direction.
	outsider.Get(api("/circles/" + circleID + "/blobs/avatar/" + member.AccountID() + "/hash-1")).
		Expect(http.StatusForbidden)
	outsider.Post(api("/circles/"+circleID+"/blobs/avatar/hash-2/upload-target"), nil).
		Expect(http.StatusForbidden)
}

// A face is not something an admin sets for you, and the version has to
// be the one the bytes were sealed under.
func TestCircleAvatars_OnlyYourOwn(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	admin.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"avatarId":   "hash-1",
		"keyVersion": 1,
	}).Expect(http.StatusForbidden)

	member.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"avatarId":   "hash-1",
		"keyVersion": 99,
	}).Expect(http.StatusConflict)

	member.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"avatarId":   "../escape",
		"keyVersion": 1,
	}).Expect(http.StatusBadRequest)
}

// Leaving takes the picture with you: it was sealed to a circle you are
// no longer in, and nothing will name it again.
func TestCircleAvatars_LeavingTakesThePicture(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	target := circleAvatarTarget(t, member, circleID, "hash-1")
	harness.PostBlob(t, target.URL, target.Fields, []byte("sealed picture"))
	member.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"avatarId":   "hash-1",
		"keyVersion": 1,
	}).Expect(http.StatusNoContent)

	// A URL taken before they left still signs — signing is local, and
	// says nothing about whether the object is there.
	var download struct {
		URL string `json:"url"`
	}
	admin.Get(api("/circles/" + circleID + "/blobs/avatar/" + member.AccountID() + "/hash-1")).
		Expect(http.StatusOK).Decode(&download)
	harness.AssertEqual(t, fetchStatus(t, download.URL), http.StatusOK, "the picture is there while they are")

	member.Post(api("/circles/"+circleID+"/leave"), harness.Body{
		"expectedVersion": 1,
		"sealed": map[string]string{
			admin.AccountID(): base64.StdEncoding.EncodeToString([]byte("v2-admin")),
		},
	}).Expect(http.StatusNoContent)

	harness.AssertEqual(t, fetchStatus(t, download.URL), http.StatusNotFound, "and gone once they leave")
}

func circleAvatarTarget(t *testing.T, device *harness.Device, circleID, avatarID string) struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
} {
	t.Helper()
	var target struct {
		URL    string            `json:"url"`
		Fields map[string]string `json:"fields"`
	}
	device.Post(api("/circles/"+circleID+"/blobs/avatar/"+avatarID+"/upload-target"), nil).
		Expect(http.StatusOK).Decode(&target)
	return target
}
