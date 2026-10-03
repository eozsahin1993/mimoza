package integration_test

import (
	"encoding/base64"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// Live codes are every admin's, not just whoever made them: a second
// admin can list and revoke a code they did not create, since either
// one of them might need to.
func TestInvites_AreEveryAdminsNotJustTheCreators(t *testing.T) {
	relay := harness.Start(t)
	founder := relay.SignIn()
	circleID := createCircle(t, founder, "Family")
	secondAdmin := relay.SignIn()
	joinCircle(t, founder, secondAdmin, circleID)
	founder.Patch(api("/circles/"+circleID+"/members/"+secondAdmin.AccountID()), harness.Body{
		"role": "admin",
	}).Expect(http.StatusNoContent)

	var invite struct {
		Code string `json:"code"`
	}
	founder.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)

	var listed struct {
		Invites []struct {
			Code      string `json:"code"`
			CreatedBy string `json:"createdBy"`
		} `json:"invites"`
	}
	secondAdmin.Get(api("/circles/" + circleID + "/invites")).Expect(http.StatusOK).Decode(&listed)
	found := false
	for _, entry := range listed.Invites {
		if entry.Code == invite.Code {
			found = true
			harness.AssertEqual(t, entry.CreatedBy, founder.AccountID(), "the list says who actually made it")
		}
	}
	harness.AssertTrue(t, found, "the second admin can see a code they did not create")

	secondAdmin.Delete(api("/circles/" + circleID + "/invites/" + invite.Code)).Expect(http.StatusNoContent)
	founder.Get(api("/invites/" + invite.Code)).Expect(http.StatusNotFound)
}

// A revoked code is dead immediately: nobody can use it to ask, however
// recently it was live.
func TestInvites_ARevokedCodeCannotBeUsedToAsk(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	asker := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)
	admin.Delete(api("/circles/" + circleID + "/invites/" + invite.Code)).Expect(http.StatusNoContent)

	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusNotFound)
}

// Asking twice with the same account replaces the first ask rather than
// queueing a second one an admin has to separately answer.
func TestInvites_AskingTwiceReplacesTheFirstAsk(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	asker := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)

	var first, second struct {
		RequestID string `json:"requestId"`
	}
	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&first)
	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&second)
	harness.AssertEqual(t, second.RequestID, first.RequestID, "the same ask, not a second one")

	var pending struct {
		Requests []struct {
			RequestID string `json:"requestId"`
		} `json:"requests"`
	}
	admin.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusOK).Decode(&pending)
	harness.AssertEqual(t, len(pending.Requests), 1, "one ask waiting, not two")
}

// Someone already a member has nothing to ask for, and an admin should
// never be bothered answering it.
func TestInvites_AMemberAskingAgainIsRefused(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)
	member.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusConflict)
}

// Denying flips the ask's status rather than deleting it — the list
// endpoint is a circle's whole history, not just what is still open
// (the client filters to "pending" itself; see discoverPendingRequests
// in invite-to-circle.ts), so a denied ask stays listed, just answered.
// Answering it again, deny or approve, is refused rather than silently
// doing nothing: an admin needs to know a double-tap did not quietly
// re-deny someone another admin already handled.
func TestInvites_DenyingMarksTheAskAndCannotBeRepeated(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	asker := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)
	var request struct {
		RequestID string `json:"requestId"`
	}
	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&request)

	admin.Post(api("/circles/"+circleID+"/requests/"+request.RequestID+"/deny"), nil).Expect(http.StatusNoContent)

	var listed struct {
		Requests []struct {
			RequestID string `json:"requestId"`
			Status    string `json:"status"`
		} `json:"requests"`
	}
	admin.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusOK).Decode(&listed)
	harness.AssertEqual(t, len(listed.Requests), 1, "the ask stays in the circle's history")
	harness.AssertEqual(t, listed.Requests[0].Status, "denied", "marked, not deleted")

	admin.Post(api("/circles/"+circleID+"/requests/"+request.RequestID+"/deny"), nil).Expect(http.StatusNotFound)
	admin.Post(api("/circles/"+circleID+"/requests/"+request.RequestID+"/approve"), harness.Body{
		"sealed": map[string]string{"1": base64.StdEncoding.EncodeToString([]byte("sealed-v1"))},
	}).Expect(http.StatusNotFound)
}

// Only an admin may deny, same as approve — a member answering someone
// else's ask is not a thing.
func TestInvites_OnlyAnAdminMayDeny(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	member := relay.SignIn()
	asker := relay.SignIn()
	circleID := createCircle(t, admin, "Family")
	joinCircle(t, admin, member, circleID)

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)
	var request struct {
		RequestID string `json:"requestId"`
	}
	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&request)

	member.Post(api("/circles/"+circleID+"/requests/"+request.RequestID+"/deny"), nil).Expect(http.StatusForbidden)
}

// An asker can take their own ask back, and it is gone everywhere it was
// read: the admin's list, the asker's own sync list, and any approval an
// admin still had in hand. Asking again afterwards works as normal.
func TestInvites_AnAskerCanTakeTheirAskBack(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	asker := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)
	var request struct {
		RequestID string `json:"requestId"`
	}
	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&request)
	harness.AssertEqual(t, len(syncList(t, asker).Requests), 1, "waiting before withdrawing")

	asker.Delete(api("/circles/" + circleID + "/requests/" + request.RequestID)).Expect(http.StatusNoContent)

	var pending struct {
		Requests []struct {
			RequestID string `json:"requestId"`
		} `json:"requests"`
	}
	admin.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusOK).Decode(&pending)
	harness.AssertEqual(t, len(pending.Requests), 0, "the admin no longer sees it")
	harness.AssertEqual(t, len(syncList(t, asker).Requests), 0, "and the asker is no longer waiting")

	// An admin who loaded the list a moment earlier cannot admit someone
	// who took the ask back, and the asker is not a member as a result.
	admin.Post(api("/circles/"+circleID+"/requests/"+request.RequestID+"/approve"), harness.Body{
		"sealed": map[string]string{"1": base64.StdEncoding.EncodeToString([]byte("sealed-v1"))},
	}).Expect(http.StatusNotFound)
	harness.AssertEqual(t, len(syncList(t, asker).Circles), 0, "withdrawn means not admitted")

	// Doing it twice says so, so a retry after a lost response is
	// recognisable rather than mistaken for success.
	asker.Delete(api("/circles/" + circleID + "/requests/" + request.RequestID)).Expect(http.StatusNotFound)

	var again struct {
		RequestID string `json:"requestId"`
	}
	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&again)
	harness.AssertEqual(t, again.RequestID, request.RequestID, "the same account's ask has the same id")
	admin.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusOK).Decode(&pending)
	harness.AssertEqual(t, len(pending.Requests), 1, "asking again puts it back in front of the admin")
}

// Withdrawing is the asker's alone. Someone else holding an ask's id,
// even an admin of that circle, gets the same answer as for an ask that
// does not exist, and the ask stands.
func TestInvites_OnlyTheAskerMayWithdrawAnAsk(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	asker := relay.SignIn()
	other := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)
	var request struct {
		RequestID string `json:"requestId"`
	}
	asker.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&request)
	other.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated)

	path := api("/circles/" + circleID + "/requests/" + request.RequestID)
	other.Delete(path).Expect(http.StatusNotFound)
	admin.Delete(path).Expect(http.StatusNotFound)
	relay.Anon().Delete(path).Expect(http.StatusUnauthorized)

	var pending struct {
		Requests []struct {
			RequestID string `json:"requestId"`
			Status    string `json:"status"`
		} `json:"requests"`
	}
	admin.Get(api("/circles/" + circleID + "/requests")).Expect(http.StatusOK).Decode(&pending)
	harness.AssertEqual(t, len(pending.Requests), 2, "both asks are still waiting")
	for _, entry := range pending.Requests {
		harness.AssertEqual(t, entry.Status, "pending", "nobody's ask was touched")
	}

	// Someone with no ask at all has nothing to withdraw.
	stranger := relay.SignIn()
	stranger.Delete(path).Expect(http.StatusNotFound)
}

// An answer is not something to withdraw: a denial is what its asker is
// still reading, and an approval made them a member. Both read as not
// there, and neither is disturbed.
func TestInvites_WithdrawingDoesNotUndoAnAnswer(t *testing.T) {
	relay := harness.Start(t)
	admin := relay.SignIn()
	denied := relay.SignIn()
	admitted := relay.SignIn()
	circleID := createCircle(t, admin, "Family")

	var invite struct {
		Code string `json:"code"`
	}
	admin.Post(api("/circles/"+circleID+"/invites"), nil).Expect(http.StatusCreated).Decode(&invite)
	var turnedAway, letIn struct {
		RequestID string `json:"requestId"`
	}
	denied.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&turnedAway)
	admitted.Post(api("/invites/"+invite.Code+"/requests"), nil).Expect(http.StatusCreated).Decode(&letIn)

	admin.Post(api("/circles/"+circleID+"/requests/"+turnedAway.RequestID+"/deny"), nil).Expect(http.StatusNoContent)
	admin.Post(api("/circles/"+circleID+"/requests/"+letIn.RequestID+"/approve"), harness.Body{
		"sealed": map[string]string{"1": base64.StdEncoding.EncodeToString([]byte("sealed-v1"))},
	}).Expect(http.StatusNoContent)

	denied.Delete(api("/circles/" + circleID + "/requests/" + turnedAway.RequestID)).Expect(http.StatusNotFound)
	waiting := syncList(t, denied)
	harness.AssertEqual(t, len(waiting.Requests), 1, "the denial is still theirs to read")
	harness.AssertEqual(t, waiting.Requests[0].Status, "denied", "as it was")

	admitted.Delete(api("/circles/" + circleID + "/requests/" + letIn.RequestID)).Expect(http.StatusNotFound)
	harness.AssertEqual(t, len(syncList(t, admitted).Circles), 1, "still a member")
}
