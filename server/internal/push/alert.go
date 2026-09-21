package push

// Placeholder is what a device shows for a circle push it cannot decrypt —
// the extension/handler failed, or the push was forged by someone without
// the circle's key.
const Placeholder = "New activity"

// Alert is the fixed line sent with every push to an address of this kind:
// what shows when the device can't write its own, including on an app too
// old to know the kind. Taken from the recipient's own row, never from the
// sender, so a forged push can only ever put one of these on a lock screen.
func (k PushKind) Alert() string {
	switch k {
	case KindInvite:
		return "Someone wants to join a circle"
	case KindPendingRequest:
		return "There's news on your request to join a circle"
	default:
		return Placeholder
	}
}
