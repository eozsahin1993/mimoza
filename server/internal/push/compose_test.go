package push

import "testing"

// A tap needs the request's own id to tell whether it's still the one
// waiting, since another admin may have already answered it.
func TestCompose_JoinRequestCarriesTheRequestID(t *testing.T) {
	message := compose(Event{Kind: KindJoinRequest, CircleID: "circle-1", RequestID: "request-1"}, "Sarah", "Family", "admin-1")

	if message.Data["requestId"] != "request-1" {
		t.Errorf("Data[requestId] = %q, want request-1", message.Data["requestId"])
	}
}

// Nothing else carries one: an empty RequestID must not show up as the
// literal string "" in the payload a tap reads.
func TestCompose_OnlyJoinRequestCarriesARequestID(t *testing.T) {
	message := compose(Event{Kind: KindPost, CircleID: "circle-1", EntryID: "post-1"}, "Sarah", "Family", "member-1")

	if _, present := message.Data["requestId"]; present {
		t.Errorf("expected no requestId on a post notification, got %+v", message.Data)
	}
}
