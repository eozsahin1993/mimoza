package push

import "crypto/sha256"

// PushFanoutHash is sha256(pushFanoutToken || pushRoutingId) — stored on the prefs
// row, recomputed on each send.
//
// Salted by routing id because every member of a circle derives the same
// token: a bare hash would write one identical value across that circle's
// rows and cluster its membership straight out of a table scan.
//
// Clients compute this too, so the concatenation order is contract.
func PushFanoutHash(pushFanoutToken []byte, pushRoutingID string) []byte {
	return saltedHash(pushFanoutToken, pushRoutingID)
}

// OwnerHash is sha256(ownerToken || pushRoutingId), the prefs row's lock on
// writes. The token derives from the owner's seed, so unlike the routing id
// it is never shared with other members.
func OwnerHash(ownerToken []byte, pushRoutingID string) []byte {
	return saltedHash(ownerToken, pushRoutingID)
}

func saltedHash(token []byte, pushRoutingID string) []byte {
	sum := sha256.New()
	sum.Write(token)
	sum.Write([]byte(pushRoutingID))
	return sum.Sum(nil)
}
