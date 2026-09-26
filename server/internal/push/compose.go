package push

// Loc keys the app ships strings for. The body names the actor and, for
// a comment or a reaction, whether the photo was yours — which is the
// difference between "commented on your photo" and "commented on a
// photo", and the relay knows it without reading either.
const (
	keyPosted          = "push.posted"
	keyCommentedYours  = "push.commented_yours"
	keyCommentedOther  = "push.commented_other"
	keyReactedYours    = "push.reacted_yours"
	keyReactedOther    = "push.reacted_other"
	keyJoinRequest     = "push.join_request"
	keyApproved        = "push.approved"
	keyRewrapped       = "push.rewrapped"
	keyRewrapNeeded    = "push.rewrap_needed"
	keyCircleTitle     = "push.title_circle"
	keyAccountTitleKey = "push.title_account"
)

// Android notification channel ids, matching channels.ts on the client
// (circleNotificationChannelId/INVITES_CHANNEL_ID) exactly — a mismatch
// here silently falls back to expo-notifications' own high-importance
// channel, since the client only ever posts to a channel it finds already
// created.
const (
	channelInvites      = "invites"
	channelCirclePrefix = "circle-"
)

// channelID names the channel a card lands on. A join request or its
// approval goes to the shared invites channel rather than the circle's
// own: a requester has no circle channel yet, and an admin muting their
// own circle shouldn't silence requests to join it. Everything else is
// scoped to the circle it happened in.
func channelID(kind, circleID string) string {
	switch kind {
	case KindJoinRequest, KindApproved:
		return channelInvites
	default:
		return channelCirclePrefix + circleID
	}
}

// compose builds the card one recipient sees. actor and circle are the
// names it is rendered with; recipient decides whose photo it was.
func compose(event Event, actor, circle, recipient string) Message {
	message := Message{
		TitleKey: keyCircleTitle,
		Args:     []string{actor, circle},
		Data: map[string]string{
			"circleId":  event.CircleID,
			"type":      event.Kind,
			"channelId": channelID(event.Kind, event.CircleID),
		},
	}
	if event.EntryID != "" {
		message.Data["entryId"] = event.EntryID
	}
	if event.ParentID != "" {
		message.Data["parentEntryId"] = event.ParentID
	}
	if event.RequestID != "" {
		message.Data["requestId"] = event.RequestID
	}

	yours := event.AuthorID != "" && event.AuthorID == recipient
	switch event.Kind {
	case KindPost:
		message.BodyKey = keyPosted
	case KindComment:
		message.BodyKey = keyCommentedOther
		if yours {
			message.BodyKey = keyCommentedYours
		}
	case KindReaction:
		message.BodyKey = keyReactedOther
		if yours {
			message.BodyKey = keyReactedYours
		}
	case KindJoinRequest:
		message.BodyKey = keyJoinRequest
	case KindApproved:
		message.BodyKey = keyApproved
	case KindRewrapNeeded:
		message.BodyKey = keyRewrapNeeded
	case KindRewrapped:
		message.TitleKey = keyAccountTitleKey
		message.BodyKey = keyRewrapped
	case KindRoster:
		message.Silent = true
		message.TitleKey, message.BodyKey, message.Args = "", "", nil
	}
	return message
}
