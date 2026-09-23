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

// The relay owns who people are, so the roster is where a device learns
// the names it renders and the keys it seals to. Without this join a
// client holds nothing but account ids.
func TestCircles_TheRosterSaysWhoEveryoneIs(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	admin.Put(api("/account/profile"), harness.Body{"name": "Sarah"}).Expect(http.StatusOK)
	member.Put(api("/account/profile"), harness.Body{"name": "Ali"}).Expect(http.StatusOK)

	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	var roster struct {
		Members []struct {
			AccountID string `json:"accountId"`
			Name      string `json:"name"`
			PublicKey string `json:"publicKey"`
			Role      string `json:"role"`
		} `json:"members"`
	}
	member.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&roster)
	harness.AssertEqual(t, len(roster.Members), 2, "both members")

	byID := map[string]string{}
	for _, entry := range roster.Members {
		byID[entry.AccountID] = entry.Name
		harness.AssertTrue(t, entry.PublicKey != "", "every member carries the key to seal to")
	}
	harness.AssertEqual(t, byID[admin.AccountID()], "Sarah", "the admin is named")
	harness.AssertEqual(t, byID[member.AccountID()], "Ali", "and so is the member")

	for _, entry := range roster.Members {
		if entry.AccountID == admin.AccountID() {
			harness.AssertEqual(t, entry.Role, "admin", "the membership survives the join")
		}
	}

	// A name changes on the account, and the roster says so everywhere.
	member.Put(api("/account/profile"), harness.Body{"name": "Ali Riza"}).Expect(http.StatusOK)
	admin.Get(api("/circles/" + circleID + "/roster")).Expect(http.StatusOK).Decode(&roster)
	for _, entry := range roster.Members {
		if entry.AccountID == member.AccountID() {
			harness.AssertEqual(t, entry.Name, "Ali Riza", "the new name reaches the other member")
		}
	}
}

// An admin answers a person, not an account id, so a pending ask
// carries who is asking.
func TestCircles_APendingRequestNamesWhoIsAsking(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	joiner := relay.SignIn()
	joiner.Put(api("/account/profile"), harness.Body{"name": "Ali"}).Expect(http.StatusOK)

	circleID := createCircle(t, admin, "Family")
	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)
	joiner.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated)

	var pending struct {
		Requests []struct {
			AccountID string `json:"accountId"`
			Name      string `json:"name"`
			AvatarID  string `json:"avatarId"`
		} `json:"requests"`
	}
	admin.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusOK).Decode(&pending)
	harness.AssertEqual(t, len(pending.Requests), 1, "one ask")
	harness.AssertEqual(t, pending.Requests[0].Name, "Ali", "named")
	// A name and no face: the asker holds no key to seal one with yet.
	harness.AssertEqual(t, pending.Requests[0].AvatarID, "", "and no picture, since they hold no key")
	harness.AssertEqual(t, pending.Requests[0].AccountID, joiner.AccountID(), "and the account behind it")
}

// The wall has to say who left after they are gone, so the activity the
// relay writes carries the name as it was at the time.
func TestCircles_ActivityKeepsTheNameOfWhoeverLeft(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	member.Put(api("/account/profile"), harness.Body{"name": "Ali"}).Expect(http.StatusOK)

	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)
	member.Post(api("/circles/"+circleID+"/leave"), harness.Body{
		"expectedVersion": 1,
		"sealed": map[string]string{
			admin.AccountID(): base64.StdEncoding.EncodeToString([]byte("v2-admin")),
		},
	}).Expect(http.StatusNoContent)

	var page struct {
		Entries []struct {
			Event       string `json:"event"`
			SubjectID   string `json:"subjectId"`
			SubjectName string `json:"subjectName"`
		} `json:"entries"`
	}
	admin.Get(api("/circles/" + circleID + "/entries?type=activity")).Expect(http.StatusOK).Decode(&page)

	var left, joined bool
	for _, entry := range page.Entries {
		if entry.SubjectID != member.AccountID() {
			continue
		}
		switch entry.Event {
		case "left":
			left = true
			harness.AssertEqual(t, entry.SubjectName, "Ali", "the departure keeps the name")
		case "joined":
			joined = true
			harness.AssertEqual(t, entry.SubjectName, "Ali", "and so does the arrival")
		}
	}
	harness.AssertTrue(t, left, "the departure is on the wall")
	harness.AssertTrue(t, joined, "and the arrival before it")
}

// A circle must always have someone who can rotate a key or admit
// anyone, so its last admin has to hand that on before going.
func TestCircles_TheLastAdminCannotLeaveOrStepDown(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	leaveBody := harness.Body{
		"expectedVersion": 1,
		"sealed": map[string]string{
			member.AccountID(): base64.StdEncoding.EncodeToString([]byte("v2-member")),
		},
	}
	admin.Post(api("/circles/"+circleID+"/leave"), leaveBody).Expect(http.StatusConflict)
	admin.Patch(api("/circles/"+circleID+"/members/"+admin.AccountID()), harness.Body{
		"role": "member",
	}).Expect(http.StatusConflict)

	// Hand it on, and both become possible.
	admin.Patch(api("/circles/"+circleID+"/members/"+member.AccountID()), harness.Body{
		"role": "admin",
	}).Expect(http.StatusNoContent)
	admin.Post(api("/circles/"+circleID+"/leave"), leaveBody).Expect(http.StatusNoContent)

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
