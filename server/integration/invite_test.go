package integration_test

import (
	"fmt"
	"net/http"
	"testing"

	"mimoza-relay/integration/harness"
)

// The invite mailbox, end to end. Every test here is a sequence, because
// that's where the flow's real behaviour lives: a request that outlives
// its approval, an approval readable after a dismissal, a tag that still
// answers once its rows are gone.

// device wraps harness.Device with this file's own vocabulary — the
// invite flow's steps — so a sequence still reads as steps taken rather
// than method-and-path. Embedding rather than a harness.Device method:
// Go doesn't let a different package add methods to another's type.
type device struct{ *harness.Device }

func signIn(r *harness.Relay) device { return device{r.SignIn()} }
func anon(r *harness.Relay) device   { return device{r.Anon()} }

func invitePath(tag string) string { return "/v1/invites/" + tag }

func requestPath(tag, requester string) string {
	return fmt.Sprintf("/v1/invites/%s/requests/%s", tag, requester)
}

// createInvite mints an invite and returns its tag.
func (d device) createInvite() string {
	tag := harness.Suffix()
	d.Post("/v1/invites", harness.Body{"inviteTag": tag, "encryptedPreview": harness.Ciphertext()}).Expect(http.StatusOK)
	return tag
}

func (d device) readInvite(tag string) harness.Response {
	return d.Get(invitePath(tag))
}

func (d device) askToJoin(tag, requester string) harness.Response {
	return d.Put(requestPath(tag, requester), harness.Body{"encryptedRequest": harness.Ciphertext()})
}

func (d device) approve(tag, requester, approval string) harness.Response {
	return d.Put(requestPath(tag, requester)+"/approval", harness.Body{"encryptedApproval": approval})
}

func (d device) dismiss(tag, requester string) harness.Response {
	return d.Delete(requestPath(tag, requester))
}

func (d device) readRequest(tag, requester string) harness.Response {
	return d.Get(requestPath(tag, requester))
}

// requestRow is one row as the relay hands it back. EncryptedApproval is a
// pointer because nil and empty mean different things: nobody has
// approved, versus approved with nothing in it.
type requestRow struct {
	RequesterID       string
	EncryptedRequest  string
	EncryptedApproval *string
}

// pendingRequests is the creator's view of one invite's mailbox.
func (d device) pendingRequests(tag string) []requestRow {
	var listed struct{ Requests []requestRow }
	d.Get(invitePath(tag) + "/requests").Expect(http.StatusOK).Decode(&listed)
	return listed.Requests
}

func TestInviteIsReadableByWhoeverHoldsTheTag(t *testing.T) {
	r := harness.Start(t)
	tag := signIn(r).createInvite()

	// A stranger with a session, not the creator: the tag *is* the
	// capability, so the relay must not care who asks. It never learns who
	// is inviting whom.
	var preview struct{ EncryptedPreview string }
	signIn(r).readInvite(tag).Expect(http.StatusOK).Decode(&preview)

	harness.AssertTrue(t, preview.EncryptedPreview != "", "the invite came back with no preview")
}

func TestAnInviteCannotBeOverwritten(t *testing.T) {
	r := harness.Start(t)
	creator := signIn(r)
	tag := creator.createInvite()
	var original struct{ EncryptedPreview string }
	creator.readInvite(tag).Expect(http.StatusOK).Decode(&original)

	// Someone else holding the code knows the tag too. Replacing the
	// preview would let them swap in their own createdByPublicKey.
	signIn(r).Post("/v1/invites", harness.Body{"inviteTag": tag, "encryptedPreview": harness.Ciphertext()}).Expect(http.StatusConflict)

	var after struct{ EncryptedPreview string }
	creator.readInvite(tag).Expect(http.StatusOK).Decode(&after)
	harness.AssertTrue(t, after.EncryptedPreview == original.EncryptedPreview, "the preview was replaced")
}

func TestAnUnknownInviteTagIsNotFound(t *testing.T) {
	r := harness.Start(t)

	signIn(r).readInvite(harness.Suffix()).Expect(http.StatusNotFound)
}

func TestTheInviteFlowIsSessionGated(t *testing.T) {
	r := harness.Start(t)
	tag := signIn(r).createInvite()

	// Not because the relay knows who should read an invite — it doesn't —
	// but because no /invites/ route is reachable without a session at
	// all. Worth pinning: the tag is a capability, and an unauthenticated
	// caller who guessed one would otherwise be able to use it.
	anon(r).readInvite(tag).Expect(http.StatusUnauthorized)
}

func TestRequestThenApproveThenRead(t *testing.T) {
	r := harness.Start(t)
	creator, joiner := signIn(r), signIn(r)
	tag := creator.createInvite()
	requester := harness.Suffix()

	joiner.askToJoin(tag, requester).Expect(http.StatusOK)

	pending := creator.pendingRequests(tag)
	harness.AssertEqual(t, len(pending), 1, "pending requests")
	harness.AssertEqual(t, pending[0].RequesterID, requester, "the pending requester")
	harness.AssertTrue(t, pending[0].EncryptedApproval == nil, "a request nobody approved came back with an approval")

	approval := harness.Ciphertext()
	creator.approve(tag, requester, approval).Expect(http.StatusOK)

	// The joiner collects it. This is the handoff the whole flow exists
	// for, and the only step where the joiner reads rather than writes.
	var collected requestRow
	joiner.readRequest(tag, requester).Expect(http.StatusOK).Decode(&collected)

	harness.AssertTrue(t, collected.EncryptedApproval != nil, "the approval never reached the joiner")
	harness.AssertEqual(t, *collected.EncryptedApproval, approval, "the collected approval")
}

func TestApprovingSomethingNobodyAskedForIsNotFound(t *testing.T) {
	r := harness.Start(t)
	creator := signIn(r)
	tag := creator.createInvite()

	// Approval updates a row in place, so with no request there is nothing
	// to update — and it must not conjure one. A created-from-nothing
	// approval would be an admission the requester never made.
	creator.approve(tag, harness.Suffix(), harness.Ciphertext()).Expect(http.StatusNotFound)
}

func TestDismissingARequestRemovesIt(t *testing.T) {
	r := harness.Start(t)
	creator := signIn(r)
	tag := creator.createInvite()
	requester := harness.Suffix()

	creator.askToJoin(tag, requester).Expect(http.StatusOK)
	creator.dismiss(tag, requester).Expect(http.StatusOK)

	creator.readRequest(tag, requester).Expect(http.StatusNotFound)
	harness.AssertEqual(t, len(creator.pendingRequests(tag)), 0, "requests left after a dismissal")
}

func TestADismissedRequestCannotBeApproved(t *testing.T) {
	r := harness.Start(t)
	creator := signIn(r)
	tag := creator.createInvite()
	requester := harness.Suffix()

	creator.askToJoin(tag, requester).Expect(http.StatusOK)
	creator.dismiss(tag, requester).Expect(http.StatusOK)

	// The sequence that matters: dismissing then approving must not
	// resurrect the row. If it did, a decision already taken would be
	// silently reversed by a late approval.
	creator.approve(tag, requester, harness.Ciphertext()).Expect(http.StatusNotFound)
}

func TestDismissingIsIdempotent(t *testing.T) {
	r := harness.Start(t)
	creator := signIn(r)
	tag := creator.createInvite()
	requester := harness.Suffix()

	creator.askToJoin(tag, requester).Expect(http.StatusOK)

	// Twice, then once more for a request that never existed. A client
	// retrying a dismissal it isn't sure landed shouldn't see an error.
	creator.dismiss(tag, requester).Expect(http.StatusOK)
	creator.dismiss(tag, requester).Expect(http.StatusOK)
	creator.dismiss(tag, harness.Suffix()).Expect(http.StatusOK)
}

func TestARepeatedRequestIsAnIdempotentRetry(t *testing.T) {
	r := harness.Start(t)
	creator, joiner := signIn(r), signIn(r)
	tag := creator.createInvite()
	requester := harness.Suffix()

	joiner.askToJoin(tag, requester).Expect(http.StatusOK)
	first := creator.pendingRequests(tag)[0].EncryptedRequest

	// Same requester id, fresh payload. A requester id is randomly chosen,
	// so this can only be a retry of one submission — and it must converge
	// rather than error, or a joiner unsure whether their request landed
	// has no safe move.
	joiner.askToJoin(tag, requester).Expect(http.StatusOK)

	after := creator.pendingRequests(tag)
	harness.AssertEqual(t, len(after), 1, "rows after a retry")
	// The first payload wins, deliberately: the creator may already have
	// sealed an approval to the ephemeral key in it, and letting a later
	// PUT swap the payload would strand that approval against a key the
	// joiner no longer holds.
	harness.AssertEqual(t, after[0].EncryptedRequest, first, "the surviving request")
}

func TestRequestsAreScopedToTheirInvite(t *testing.T) {
	r := harness.Start(t)
	creator := signIn(r)
	mine, theirs := creator.createInvite(), creator.createInvite()
	requester := harness.Suffix()

	creator.askToJoin(mine, requester).Expect(http.StatusOK)

	// Same requester id, different tag: the row belongs to one invite and
	// must not be visible through another. Requester ids are client-chosen,
	// so this is the boundary stopping one invite's mailbox leaking into
	// the next.
	creator.readRequest(theirs, requester).Expect(http.StatusNotFound)
	harness.AssertEqual(t, len(creator.pendingRequests(theirs)), 0, "requests under the other invite")
}

func TestARequestNeedsNoInviteToExist(t *testing.T) {
	r := harness.Start(t)

	// Documents what happens today rather than asserting a rule: the
	// mailbox is keyed by tag, and nothing checks the invite row is there
	// first. A request against a tag nobody minted is accepted and simply
	// has no reader. If that ever becomes a 404, this test says so.
	signIn(r).askToJoin(harness.Suffix(), harness.Suffix()).Expect(http.StatusOK)
}

func TestAMissingOrMalformedFieldIsRejected(t *testing.T) {
	r := harness.Start(t)
	d := signIn(r)
	tag := harness.Suffix()

	cases := []struct {
		what  string
		path  string
		field string
	}{
		{"request", requestPath(tag, harness.Suffix()), "encryptedRequest"},
	}

	for _, c := range cases {
		t.Run(c.what+" missing", func(t *testing.T) {
			d.Put(c.path, harness.Body{}).Expect(http.StatusBadRequest)
		})
		t.Run(c.what+" not base64", func(t *testing.T) {
			d.Put(c.path, harness.Body{c.field: "not base64!"}).Expect(http.StatusBadRequest)
		})
	}

	t.Run("invite preview not base64", func(t *testing.T) {
		d.Post("/v1/invites", harness.Body{"inviteTag": harness.Suffix(), "encryptedPreview": "not base64!"}).Expect(http.StatusBadRequest)
	})
	t.Run("invite tag missing", func(t *testing.T) {
		d.Post("/v1/invites", harness.Body{"encryptedPreview": harness.Ciphertext()}).Expect(http.StatusBadRequest)
	})
	t.Run("invite preview missing", func(t *testing.T) {
		d.Post("/v1/invites", harness.Body{"inviteTag": harness.Suffix()}).Expect(http.StatusBadRequest)
	})
}
