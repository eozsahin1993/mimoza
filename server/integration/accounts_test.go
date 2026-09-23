package integration_test

import (
	"encoding/base64"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// An account is the relay's own, and a sign-in resolves to it. These go
// through HTTP because what matters is that the session, the profile and
// the circles all agree on who someone is.
func TestAccounts_ProfileBelongsToTheSession(t *testing.T) {
	relay := harness.Start(t)
	device := relay.SignIn()
	other := relay.SignIn()

	var profile struct {
		AccountID string `json:"accountId"`
		Name      string `json:"name"`
		PublicKey string `json:"publicKey"`
	}
	device.Get(api("/account")).Expect(http.StatusOK).Decode(&profile)
	harness.AssertEqual(t, profile.AccountID, device.AccountID(), "the profile is the caller's own")
	harness.AssertEqual(t, profile.Name, "", "and starts without a name")

	// No picture here: a face is circle content, kept on the membership
	// rather than the account — see TestCircleAvatars.
	device.Put(api("/account/profile"), harness.Body{"name": "Sarah"}).
		Expect(http.StatusOK).Decode(&profile)
	harness.AssertEqual(t, profile.Name, "Sarah", "the name took")

	// Another account sees its own, not this one's.
	var theirs struct {
		AccountID string `json:"accountId"`
		Name      string `json:"name"`
	}
	other.Get(api("/account")).Expect(http.StatusOK).Decode(&theirs)
	harness.AssertEqual(t, theirs.Name, "", "another account is untouched")
	harness.AssertTrue(t, theirs.AccountID != profile.AccountID, "and is a different account")

	device.Put(api("/account/profile"), harness.Body{"name": ""}).Expect(http.StatusBadRequest)
	relay.Anon().Get(api("/account")).Expect(http.StatusUnauthorized)
}

// An account is created by the first sign-in and found again by every
// one after it: the provider subject is a lookup onto the relay's own
// id, so a returning device lands on the account it left, with the
// profile and the circles still on it.
func TestAccounts_ASecondSignInFindsTheSameAccount(t *testing.T) {
	relay := harness.Start(t)
	subject := "returning-" + harness.Suffix()

	first := relay.SignInAs(subject)
	first.Put(api("/account/profile"), harness.Body{"name": "Sarah"}).Expect(http.StatusOK)
	circleID := createCircle(t, first, "Family")

	// A second device for the same person: a new session, the same
	// account underneath it.
	second := relay.SignInAs(subject)
	harness.AssertEqual(t, second.AccountID(), first.AccountID(), "the same sign-in is the same account")

	var profile struct {
		AccountID string `json:"accountId"`
		Name      string `json:"name"`
		CreatedAt int64  `json:"createdAt"`
	}
	second.Get(api("/account")).Expect(http.StatusOK).Decode(&profile)
	harness.AssertEqual(t, profile.AccountID, first.AccountID(), "and reads the same profile")
	harness.AssertEqual(t, profile.Name, "Sarah", "with the name the first device set")
	harness.AssertTrue(t, profile.CreatedAt > 0, "stamped when the account was created")

	// And what the account owns is listed on it, not on the device.
	circles := listCircles(t, second)
	harness.AssertEqual(t, len(circles), 1, "one circle")
	harness.AssertEqual(t, circles[0].CircleID, circleID, "the one the first device created")
	harness.AssertEqual(t, circles[0].Role, "admin", "still theirs to run")

	// Someone else signing in is a different account with nothing on it.
	stranger := relay.SignInAs("stranger-" + harness.Suffix())
	harness.AssertTrue(t, stranger.AccountID() != first.AccountID(), "a different sign-in is a different account")
	harness.AssertEqual(t, len(listCircles(t, stranger)), 0, "who is in no circles")
}

// The public key is what members seal content keys to. Replacing it as a
// reset is how a device with no keychain gets back in, and it makes every
// sealed copy stale until another member reseals them.
func TestAccounts_ReplacingThePublicKeyAsksForARewrap(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	member.Put(api("/account/pubkey"), harness.Body{
		"publicKey": base64.StdEncoding.EncodeToString([]byte("first-key")),
	}).Expect(http.StatusOK)

	// Nothing is waiting: publishing a key is not the same as losing one.
	circles := listCircles(t, member)
	harness.AssertEqual(t, len(circles), 1, "one circle")
	harness.AssertTrue(t, !circles[0].NeedsRewrap, "and it is readable")

	// A new phone with no private key: the new pair makes every sealed
	// copy unreadable, and says so.
	var reset struct {
		AwaitingRewrap []string `json:"awaitingRewrap"`
	}
	member.Put(api("/account/pubkey"), harness.Body{
		"publicKey": base64.StdEncoding.EncodeToString([]byte("second-key")),
		"reset":     true,
	}).Expect(http.StatusOK).Decode(&reset)
	harness.AssertEqual(t, len(reset.AwaitingRewrap), 1, "the circle is waiting on a reseal")
	harness.AssertEqual(t, reset.AwaitingRewrap[0], circleID, "and it is the one they are in")

	harness.AssertTrue(t, listCircles(t, member)[0].NeedsRewrap, "which the circle list shows")

	// Another member reseals, and the flag clears.
	admin.Post(api("/circles/"+circleID+"/keys"), harness.Body{
		"accountId": member.AccountID(),
		"sealed":    map[string]string{"1": base64.StdEncoding.EncodeToString([]byte("resealed"))},
	}).Expect(http.StatusNoContent)

	harness.AssertTrue(t, !listCircles(t, member)[0].NeedsRewrap, "the reseal cleared it")
}

// Push reaches the devices an account registers, and nothing else.
func TestAccounts_DevicesComeAndGo(t *testing.T) {
	relay := harness.Start(t)
	device := relay.SignIn()

	device.Put(api("/account/devices/phone-1"), harness.Body{
		"pushToken": "token-1",
		"platform":  "ios",
		"locale":    "en",
	}).Expect(http.StatusNoContent)

	// A token rotates on its own schedule, so registering again is the
	// ordinary case rather than an error.
	device.Put(api("/account/devices/phone-1"), harness.Body{
		"pushToken": "token-2",
		"platform":  "ios",
	}).Expect(http.StatusNoContent)

	device.Put(api("/account/devices/phone-2"), harness.Body{
		"pushToken": "token-3",
		"platform":  "web",
	}).Expect(http.StatusBadRequest)

	device.Put(api("/account/devices/phone-2"), harness.Body{
		"platform": "android",
	}).Expect(http.StatusBadRequest)

	// Signing out takes this phone off, and leaves the account alone.
	device.Delete(api("/account/devices/phone-1")).Expect(http.StatusNoContent)
	device.Get(api("/account")).Expect(http.StatusOK)
}

// Deleting an account ends it everywhere: the session, the profile, and
// the devices push would have reached.
func TestAccounts_DeletingAnAccountEndsIt(t *testing.T) {
	relay := harness.Start(t)
	device := relay.SignIn()

	device.Put(api("/account/profile"), harness.Body{"name": "Sarah"}).Expect(http.StatusOK)
	device.Put(api("/account/devices/phone-1"), harness.Body{
		"pushToken": "token-1", "platform": "ios",
	}).Expect(http.StatusNoContent)

	device.Delete(api("/account")).Expect(http.StatusOK)

	// The session went with it.
	device.Get(api("/account")).Expect(http.StatusUnauthorized)
	device.Get(api("/circles")).Expect(http.StatusUnauthorized)
}

// circleRow is one row of the list a sync starts from.
type circleRow struct {
	CircleID      string `json:"circleId"`
	Name          string `json:"name"`
	Role          string `json:"role"`
	NotifyLevel   string `json:"notifyLevel"`
	KeyVersion    int64  `json:"keyVersion"`
	RosterVersion int64  `json:"rosterVersion"`
	NeedsRewrap   bool   `json:"needsRewrap"`
}

// listCircles decodes into a fresh value every time on purpose: decoding
// into a reused one keeps fields the new response leaves out, which is
// how an absent "needsRewrap" reads as the previous call's true.
func listCircles(t *testing.T, device *harness.Device) []circleRow {
	t.Helper()
	var body struct {
		Circles []circleRow `json:"circles"`
	}
	device.Get(api("/circles")).Expect(http.StatusOK).Decode(&body)
	return body.Circles
}
