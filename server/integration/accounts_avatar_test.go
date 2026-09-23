package integration_test

import (
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// A picture belongs to an account, not to a circle, and the id in its
// key is the client's content hash: a changed picture is a changed URL,
// so the edge can hold one forever and a member never sees a stale face.
func TestAvatars_APictureBelongsToAnAccountAndIsSeenByMembers(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	target := avatarTarget(t, member, "hash-1")
	harness.PostBlob(t, target.URL, target.Fields, []byte("a picture"))

	member.Put(api("/account/profile"), harness.Body{
		"name":     "Ali",
		"avatarId": "hash-1",
	}).Expect(http.StatusOK)

	// Another member learns the key from the roster, which is the only
	// place it comes from, and fetches the bytes with it.
	var roster struct {
		Members []struct {
			AccountID string `json:"accountId"`
			AvatarID  string `json:"avatarId"`
		} `json:"members"`
	}
	admin.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&roster)

	var found string
	for _, entry := range roster.Members {
		if entry.AccountID == member.AccountID() {
			found = entry.AvatarID
		}
	}
	harness.AssertEqual(t, found, "hash-1", "the roster carries the id")

	// The id plus the account it hangs off is where the picture is.
	var download struct {
		URL string `json:"url"`
	}
	admin.Get(api("/avatars/" + member.AccountID() + "/" + found)).Expect(http.StatusOK).Decode(&download)
	harness.AssertEqual(t, string(fetch(t, download.URL)), "a picture", "and the bytes come back")

	// The same key twice is bytes that are already there.
	member.Post(api("/account/avatar/hash-1/upload-target"), nil).Expect(http.StatusConflict)

	relay.Anon().Get(api("/avatars/" + member.AccountID() + "/" + found)).Expect(http.StatusUnauthorized)
}

// Replacing a picture retires the one it replaced: nothing points at the
// old key any more, so nothing should be paying to keep it.
func TestAvatars_ANewPictureRetiresTheOldOne(t *testing.T) {
	relay := harness.Start(t)
	device := relay.SignIn()

	for _, id := range []string{"hash-1", "hash-2"} {
		target := avatarTarget(t, device, id)
		harness.PostBlob(t, target.URL, target.Fields, []byte("picture "+id))
		device.Put(api("/account/profile"), harness.Body{
			"name":     "Ali",
			"avatarId": id,
		}).Expect(http.StatusOK)
	}

	// The first key is free again, which is what proves its bytes went.
	device.Post(api("/account/avatar/hash-1/upload-target"), nil).Expect(http.StatusOK)
	// The current one is still there.
	device.Post(api("/account/avatar/hash-2/upload-target"), nil).Expect(http.StatusConflict)
}

// An id becomes an object key, so it has to be something safe to put in
// one.
func TestAvatars_AnIdMustLookLikeAnId(t *testing.T) {
	relay := harness.Start(t)
	device := relay.SignIn()

	device.Post(api("/account/avatar/..%2Fescape/upload-target"), nil).Expect(http.StatusBadRequest)
	device.Post(api("/account/avatar/.hidden/upload-target"), nil).Expect(http.StatusBadRequest)
	device.Put(api("/account/profile"), harness.Body{"name": "Ali", "avatarId": "../escape"}).Expect(http.StatusBadRequest)
}

func avatarTarget(t *testing.T, device *harness.Device, avatarID string) struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
} {
	t.Helper()
	var target struct {
		URL    string            `json:"url"`
		Fields map[string]string `json:"fields"`
	}
	device.Post(api("/account/avatar/"+avatarID+"/upload-target"), nil).
		Expect(http.StatusOK).Decode(&target)
	return target
}
