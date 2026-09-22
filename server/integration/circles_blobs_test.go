package integration_test

import (
	"encoding/base64"
	"io"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// The photo behind a post never passes through the relay: it signs a
// URL and the device talks to storage directly. What the relay decides
// is who may put bytes there and who may read them back.
func TestBlobs_APhotoGoesUpOnceAndComesBackToMembers(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	outsider := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	target := uploadTarget(t, admin, circleID, "post-1")
	harness.PostBlob(t, target.URL, target.Fields, []byte("encrypted photo"))

	// The post row is what says a photo is there at all.
	admin.Post(api("/circles/"+circleID+"/entries"), harness.Body{
		"entryId":    "post-1",
		"keyVersion": 1,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("caption")),
		"hasBlob":    true,
	}).Expect(http.StatusCreated)

	// Written once: a second target for the same post would let any
	// member replace a photo with one that still decrypts.
	admin.Post(api("/circles/"+circleID+"/blobs/post-1/upload-target"), nil).Expect(http.StatusConflict)

	// Another member reads it back, and the bytes are the ones sent.
	var download struct {
		URL string `json:"url"`
	}
	member.Get(api("/circles/" + circleID + "/blobs/post-1")).Expect(http.StatusOK).Decode(&download)
	harness.AssertEqual(t, string(fetch(t, download.URL)), "encrypted photo", "the bytes come back")

	// Nobody outside the circle, in either direction.
	outsider.Get(api("/circles/" + circleID + "/blobs/post-1")).Expect(http.StatusForbidden)
	outsider.Post(api("/circles/"+circleID+"/blobs/post-2/upload-target"), nil).Expect(http.StatusForbidden)
	relay.Anon().Get(api("/circles/" + circleID + "/blobs/post-1")).Expect(http.StatusUnauthorized)
}

// Deleting a post takes its photo with it. The edge cache is told, but
// invalidation is best-effort, so refusing to sign a URL is what
// actually stops the photo being fetched again.
func TestBlobs_ADeletedPostStopsBeingSigned(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	target := uploadTarget(t, admin, circleID, "post-1")
	harness.PostBlob(t, target.URL, target.Fields, []byte("encrypted photo"))
	admin.Post(api("/circles/"+circleID+"/entries"), harness.Body{
		"entryId":    "post-1",
		"keyVersion": 1,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("caption")),
		"hasBlob":    true,
	}).Expect(http.StatusCreated)
	admin.Get(api("/circles/" + circleID + "/blobs/post-1")).Expect(http.StatusOK)

	admin.Delete(api("/circles/" + circleID + "/entries/post-1")).Expect(http.StatusOK)

	admin.Get(api("/circles/" + circleID + "/blobs/post-1")).Expect(http.StatusNotFound)
	// The bytes went with the row, so the key is free again.
	admin.Post(api("/circles/"+circleID+"/blobs/post-1/upload-target"), nil).Expect(http.StatusOK)
}

// A post with no photo has nothing to sign, and a post that does not
// exist is not a thing to ask about.
func TestBlobs_NothingToSignWithoutAPhoto(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	putPost(t, admin, circleID, "post-1", 1)
	admin.Get(api("/circles/" + circleID + "/blobs/post-1")).Expect(http.StatusNotFound)
	admin.Get(api("/circles/" + circleID + "/blobs/post-missing")).Expect(http.StatusNotFound)
}

// A cover is an admin's to set, so it is an admin's to upload. Every
// cover has a fresh id, which is what lets the edge hold one forever.
func TestBlobs_ACoverIsAnAdminsToPutThere(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	member.Post(api("/circles/"+circleID+"/blobs/cover/cover-1/upload-target"), nil).Expect(http.StatusForbidden)

	var target struct {
		URL    string            `json:"url"`
		Fields map[string]string `json:"fields"`
	}
	admin.Post(api("/circles/"+circleID+"/blobs/cover/cover-1/upload-target"), nil).
		Expect(http.StatusOK).Decode(&target)
	harness.PostBlob(t, target.URL, target.Fields, []byte("encrypted cover"))

	admin.Patch(api("/circles/"+circleID), harness.Body{"coverId": "cover-1"}).Expect(http.StatusOK)

	// Any member reads the cover, and a new one is a new id rather than
	// an overwrite.
	var download struct {
		URL string `json:"url"`
	}
	member.Get(api("/circles/" + circleID + "/blobs/cover/cover-1")).Expect(http.StatusOK).Decode(&download)
	harness.AssertEqual(t, string(fetch(t, download.URL)), "encrypted cover", "the cover comes back")

	admin.Post(api("/circles/"+circleID+"/blobs/cover/cover-1/upload-target"), nil).Expect(http.StatusConflict)
	admin.Post(api("/circles/"+circleID+"/blobs/cover/cover-2/upload-target"), nil).Expect(http.StatusOK)
}

// uploadTarget asks for somewhere to put a post's bytes.
func uploadTarget(t *testing.T, device *harness.Device, circleID, postID string) struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
} {
	t.Helper()
	var target struct {
		URL    string            `json:"url"`
		Fields map[string]string `json:"fields"`
	}
	device.Post(api("/circles/"+circleID+"/blobs/"+postID+"/upload-target"), nil).
		Expect(http.StatusOK).Decode(&target)
	return target
}

// fetch follows a signed URL the way a device does, with no session and
// no relay in the path.
func fetch(t *testing.T, url string) []byte {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("fetching the signed url: %d", response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
