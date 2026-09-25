package integration_test

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// The device-link handshake, end to end over HTTP. What matters here and
// not in the package tests is that the session, the account and the link
// agree on whose keys these are: the relay scopes a link to an account,
// so every device signed into that account can reach it and nobody else
// can, whichever session asks.

type deviceLink struct {
	SessionID     string `json:"sessionId"`
	PublicKey     string `json:"publicKey"`
	SealedKeypair string `json:"sealedKeypair"`
	ExpiresAt     int64  `json:"expiresAt"`
}

func throwawayKey(t *testing.T) string {
	t.Helper()
	return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
}

func createLink(t *testing.T, device *harness.Device, publicKey string) deviceLink {
	t.Helper()
	var link deviceLink
	device.Post(api("/account/device-link"), harness.Body{"publicKey": publicKey}).
		Expect(http.StatusCreated).Decode(&link)
	return link
}

// The whole point of the feature: a phone with no keys gets them from a
// phone that has them, without the relay ever holding something it could
// open.
func TestDeviceLink_CarriesTheKeysBetweenTwoDevicesOfOneAccount(t *testing.T) {
	relay := harness.Start(t)
	subject := "one-person-" + harness.Suffix()
	newPhone := relay.SignInAs(subject)
	oldPhone := relay.SignInAs(subject)
	harness.AssertEqual(t, oldPhone.AccountID(), newPhone.AccountID(), "two sign-ins, one account")

	publicKey := throwawayKey(t)
	link := createLink(t, newPhone, publicKey)
	harness.AssertTrue(t, link.SessionID != "", "a session id came back")

	var pending deviceLink
	newPhone.Get(api("/account/device-link/" + link.SessionID)).Expect(http.StatusOK).Decode(&pending)
	harness.AssertEqual(t, pending.SealedKeypair, "", "nothing to collect before the other phone answers")
	harness.AssertEqual(t, pending.PublicKey, publicKey, "the session holds the key it was opened with")

	sealed := base64.StdEncoding.EncodeToString([]byte("an opaque blob only the new phone can open"))
	oldPhone.Post(api("/account/device-link/"+link.SessionID), harness.Body{"sealedKeypair": sealed}).
		Expect(http.StatusNoContent)

	var collected deviceLink
	newPhone.Get(api("/account/device-link/" + link.SessionID)).Expect(http.StatusOK).Decode(&collected)
	harness.AssertEqual(t, collected.SealedKeypair, sealed, "the blob arrives byte for byte")
}

// A link is the account's, not one session's. Any device signed into the
// account can answer or read it, and the relay never has to be told which
// device is which.
func TestDeviceLink_IsReachableByAnyDeviceOfTheAccount(t *testing.T) {
	relay := harness.Start(t)
	subject := "one-person-" + harness.Suffix()
	first := relay.SignInAs(subject)
	second := relay.SignInAs(subject)
	third := relay.SignInAs(subject)

	link := createLink(t, first, throwawayKey(t))

	sealed := base64.StdEncoding.EncodeToString([]byte("from the third device"))
	third.Post(api("/account/device-link/"+link.SessionID), harness.Body{"sealedKeypair": sealed}).
		Expect(http.StatusNoContent)

	var collected deviceLink
	second.Get(api("/account/device-link/" + link.SessionID)).Expect(http.StatusOK).Decode(&collected)
	harness.AssertEqual(t, collected.SealedKeypair, sealed, "a third device's answer reaches the second")
}

// The key shape is the access check, so a stranger's session addresses a
// row in its own partition — which is empty, not forbidden.
func TestDeviceLink_IsInvisibleToAnotherAccount(t *testing.T) {
	relay := harness.Start(t)
	mine := relay.SignIn()
	stranger := relay.SignIn()
	harness.AssertTrue(t, stranger.AccountID() != mine.AccountID(), "two different accounts")

	link := createLink(t, mine, throwawayKey(t))

	stranger.Get(api("/account/device-link/" + link.SessionID)).Expect(http.StatusNotFound)
	stranger.Post(api("/account/device-link/"+link.SessionID),
		harness.Body{"sealedKeypair": base64.StdEncoding.EncodeToString([]byte("theirs"))}).
		Expect(http.StatusNotFound)

	// And the stranger's attempts left it untouched.
	var still deviceLink
	mine.Get(api("/account/device-link/" + link.SessionID)).Expect(http.StatusOK).Decode(&still)
	harness.AssertEqual(t, still.SealedKeypair, "", "the session is still waiting for a real answer")
}

// Every route sits behind the session, so a link is never reachable
// without one — not even to find out whether a session id exists.
func TestDeviceLink_NeedsASession(t *testing.T) {
	relay := harness.Start(t)
	link := createLink(t, relay.SignIn(), throwawayKey(t))

	anon := relay.Anon()
	anon.Post(api("/account/device-link"), harness.Body{"publicKey": throwawayKey(t)}).
		Expect(http.StatusUnauthorized)
	anon.Get(api("/account/device-link/" + link.SessionID)).Expect(http.StatusUnauthorized)
	anon.Post(api("/account/device-link/"+link.SessionID),
		harness.Body{"sealedKeypair": base64.StdEncoding.EncodeToString([]byte("sealed"))}).
		Expect(http.StatusUnauthorized)
}

// First answer wins, so a second scan of the same code cannot decide what
// the waiting phone ends up holding.
func TestDeviceLink_IsUsedOnce(t *testing.T) {
	relay := harness.Start(t)
	subject := "one-person-" + harness.Suffix()
	newPhone := relay.SignInAs(subject)
	oldPhone := relay.SignInAs(subject)

	link := createLink(t, newPhone, throwawayKey(t))
	first := base64.StdEncoding.EncodeToString([]byte("first"))
	second := base64.StdEncoding.EncodeToString([]byte("second"))

	oldPhone.Post(api("/account/device-link/"+link.SessionID), harness.Body{"sealedKeypair": first}).
		Expect(http.StatusNoContent)
	oldPhone.Post(api("/account/device-link/"+link.SessionID), harness.Body{"sealedKeypair": second}).
		Expect(http.StatusConflict)

	var collected deviceLink
	newPhone.Get(api("/account/device-link/" + link.SessionID)).Expect(http.StatusOK).Decode(&collected)
	harness.AssertEqual(t, collected.SealedKeypair, first, "the first answer stood")
}

// Deleting an account sweeps its whole partition, and a device link lives
// in there — so a sealed keypair cannot outlive the account it belonged
// to, TTL or no TTL.
func TestDeviceLink_DoesNotOutliveTheAccount(t *testing.T) {
	relay := harness.Start(t)
	subject := "one-person-" + harness.Suffix()
	phone := relay.SignInAs(subject)

	link := createLink(t, phone, throwawayKey(t))
	phone.Post(api("/account/device-link/"+link.SessionID),
		harness.Body{"sealedKeypair": base64.StdEncoding.EncodeToString([]byte("sealed"))}).
		Expect(http.StatusNoContent)

	phone.Delete(api("/account")).Expect(http.StatusOK)

	// Signing in again mints a brand new account, and the old link is not
	// in it.
	returning := relay.SignInAs(subject)
	harness.AssertTrue(t, returning.AccountID() != phone.AccountID(), "a deleted account does not come back")
	returning.Get(api("/account/device-link/" + link.SessionID)).Expect(http.StatusNotFound)
}
