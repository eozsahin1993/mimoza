package push

// PushKind is what a routing id addresses. Stored on the prefs row so a
// row reads on its own, and read on every send to pick the fixed line
// (Alert). Nothing authorizes on it.
type PushKind string

const (
	KindCircle         PushKind = "circle"
	KindInvite         PushKind = "invite"
	KindPendingRequest PushKind = "pending_request"
)

// Valid reports whether k is one of the three kinds above.
func (k PushKind) Valid() bool {
	return k == KindCircle || k == KindInvite || k == KindPendingRequest
}

// Temporary reports whether an address of this kind expires on its own:
// invites and pending requests only matter as long as the invite does, so
// one a phone abandons still goes away.
func (k PushKind) Temporary() bool {
	return k == KindInvite || k == KindPendingRequest
}
