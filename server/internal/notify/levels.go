package notify

import "mimoza-relay/internal/circles"

// covers reports whether a member at this notification level hears about
// this kind of event. Levels only govern what happens in a circle:
// being admitted, being asked to admit someone, and having your own keys
// resealed reach you whatever you set.
func covers(level string, kind Kind) bool {
	switch kind {
	case KindPost:
		return level == circles.NotifyAll || level == circles.NotifyComments || level == circles.NotifyPhotos
	case KindComment:
		return level == circles.NotifyAll || level == circles.NotifyComments
	case KindReaction:
		return level == circles.NotifyAll
	case KindRoster:
		// Silent, so a level that silences cards does not silence syncing.
		return true
	default:
		return true
	}
}
