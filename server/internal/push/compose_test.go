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

// A circle event lands on that circle's own Android channel, matching
// circleNotificationChannelId on the client.
func TestCompose_CircleEventUsesTheCirclesChannel(t *testing.T) {
	message := compose(Event{Kind: KindPost, CircleID: "circle-1", EntryID: "post-1"}, "Sarah", "Family", "member-1")

	if message.Data["channelId"] != "circle-circle-1" {
		t.Errorf("Data[channelId] = %q, want circle-circle-1", message.Data["channelId"])
	}
}

// The join handshake goes to the shared invites channel instead: a
// requester has no circle channel yet, and an admin muting their own
// circle shouldn't silence requests to join it.
func TestCompose_JoinHandshakeUsesTheInvitesChannel(t *testing.T) {
	for _, kind := range []Kind{KindJoinRequest, KindApproved} {
		message := compose(Event{Kind: kind, CircleID: "circle-1", RequestID: "request-1"}, "Sarah", "Family", "admin-1")

		if message.Data["channelId"] != "invites" {
			t.Errorf("kind %q: Data[channelId] = %q, want invites", kind, message.Data["channelId"])
		}
	}
}
