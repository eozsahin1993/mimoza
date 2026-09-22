package integration_test

import (
	"encoding/base64"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// Who may do what, over HTTP: the rules a client cannot be trusted to
// keep, checked where a client actually reaches them.
func TestCircles_OnlyAnAdminMayInviteRenameOrRemove(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	member.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusForbidden)
	member.Get(api("/circles/" + circleID + "/invites")).Expect(http.StatusForbidden)
	member.Patch(api("/circles/"+circleID), harness.Body{"name": "Renamed"}).Expect(http.StatusForbidden)
	member.Delete(api("/circles/" + circleID)).Expect(http.StatusForbidden)
	member.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusForbidden)
	member.Post(api("/circles/"+circleID+"/members/"+admin.AccountID()+"/remove"), harness.Body{
		"expectedVersion": 1,
		"sealed":          map[string]string{},
	}).Expect(http.StatusForbidden)

	// The same calls from the admin are fine.
	admin.Patch(api("/circles/"+circleID), harness.Body{"name": "Renamed"}).Expect(http.StatusOK)
}

// A circle must always have someone who can rotate a key or admit
// anyone, so its last admin has to hand that on before going.
func TestCircles_TheLastAdminCannotLeaveOrStepDown(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	admin.Post(api("/circles/"+circleID+"/leave"), nil).Expect(http.StatusConflict)
	admin.Patch(api("/circles/"+circleID+"/members/"+admin.AccountID()), harness.Body{
		"role": "member",
	}).Expect(http.StatusConflict)

	// Hand it on, and both become possible.
	admin.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"role": "admin",
	}).Expect(http.StatusNoContent)
	admin.Post(api("/circles/"+circleID+"/leave"), nil).Expect(http.StatusNoContent)

	// Gone: the circle is no longer theirs to read.
	admin.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusForbidden)

	var mine struct {
		Circles []struct {
			CircleID string `json:"circleId"`
			Role     string `json:"role"`
		} `json:"circles"`
	}
	member.Get(api("/circles")).Expect(http.StatusOK).Decode(&mine)
	harness.AssertEqual(t, len(mine.Circles), 1, "the circle is still the other member's")
	harness.AssertEqual(t, mine.Circles[0].Role, "admin", "who is now its admin")
}

// A notification level is a per-member preference, not something an
// admin sets on someone else's behalf.
func TestCircles_ANotificationLevelIsOnlyYourOwn(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	admin.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"notifyLevel": "none",
	}).Expect(http.StatusForbidden)

	member.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"notifyLevel": "none",
	}).Expect(http.StatusNoContent)

	var mine struct {
		Circles []struct {
			NotifyLevel string `json:"notifyLevel"`
		} `json:"circles"`
	}
	member.Get(api("/circles")).Expect(http.StatusOK).Decode(&mine)
	harness.AssertEqual(t, mine.Circles[0].NotifyLevel, "none", "their own level took")
}

// Membership of one circle says nothing about another.
func TestCircles_MembershipDoesNotCrossCircles(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	outsider := relay.SignIn()

	mine := createCircle(t, admin, "Family")
	theirs := createCircle(t, outsider, "Friends")
	putPost(t, admin, mine, "post-1", 1)

	outsider.Get(api("/circles/" + mine + "/entries?type=post")).Expect(http.StatusForbidden)
	outsider.Get(api("/circles/" + mine + "/roster")).Expect(http.StatusForbidden)
	outsider.Post(api("/circles/"+mine+"/entries"), harness.Body{
		"entryId":    "post-x",
		"keyVersion": 1,
		"ciphertext": base64.StdEncoding.EncodeToString([]byte("x")),
	}).Expect(http.StatusForbidden)

	// And each sees only their own in the list.
	var list struct {
		Circles []struct {
			CircleID string `json:"circleId"`
		} `json:"circles"`
	}
	outsider.Get(api("/circles")).Expect(http.StatusOK).Decode(&list)
	harness.AssertEqual(t, len(list.Circles), 1, "one circle")
	harness.AssertEqual(t, list.Circles[0].CircleID, theirs, "and it is their own")
}

// Resealing keys is how a member who replaced their keypair gets back
// in, and it has to carry every version or it destroys what it omits.
func TestCircles_ResealingRequiresEveryKeyVersion(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	third := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)
	joinCircle(t, admin, third, circleID)

	// Removing one rotates the key, so the circle now has two versions.
	admin.Post(api("/circles/"+circleID+"/members/"+third.AccountID()+"/remove"), harness.Body{
		"expectedVersion": 1,
		"sealed": map[string]string{
			admin.AccountID():  base64.StdEncoding.EncodeToString([]byte("v2-admin")),
			member.AccountID(): base64.StdEncoding.EncodeToString([]byte("v2-member")),
		},
	}).Expect(http.StatusNoContent)

	// Only the newest version: the history sealed under version 1 would
	// be lost, so it is refused.
	admin.Post(api("/circles/"+circleID+"/keys"), harness.Body{
		"accountId": member.AccountID(),
		"sealed":    map[string]string{"2": base64.StdEncoding.EncodeToString([]byte("v2"))},
	}).Expect(http.StatusBadRequest)

	admin.Post(api("/circles/"+circleID+"/keys"), harness.Body{
		"accountId": member.AccountID(),
		"sealed": map[string]string{
			"1": base64.StdEncoding.EncodeToString([]byte("v1")),
			"2": base64.StdEncoding.EncodeToString([]byte("v2")),
		},
	}).Expect(http.StatusNoContent)

	var roster struct {
		Keys map[string]string `json:"keys"`
	}
	member.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&roster)
	harness.AssertEqual(t, len(roster.Keys), 2, "both versions are sealed to them again")
}
