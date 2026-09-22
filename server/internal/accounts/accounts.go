// Package accounts is who is using the relay: one account per person,
// the profile every circle they are in shows, the devices push reaches
// them on, and the sign-ins that resolve to them.
//
// An account id is the relay's own, minted at first sign-in. A provider
// subject is a lookup onto it, not the id itself, so a second sign-in
// method can be linked later without the account changing underneath
// every circle it belongs to.
package accounts

import "time"

// Profile is what other members see: a name, and a picture if there is
// one. The public key is here too, since it is per account rather than
// per circle, and is what a member seals content keys to.
type Profile struct {
	AccountID string
	Name      string
	AvatarKey string
	// PublicKey is X25519, for sealing. Replacing it is how a device with
	// no keychain gets back in, and it makes every sealed key stale until
	// another member reseals them.
	PublicKey      []byte
	PublicKeySetAt time.Time
	CreatedAt      time.Time
}

// Device is one phone this account is signed in on. Push goes to these,
// and to nothing else.
type Device struct {
	DeviceID  string
	PushToken string
	Platform  string
	// Locale is what language the device wants its notifications in. The
	// relay sends localization keys rather than text, so this is only a
	// fallback for a platform that needs one.
	Locale    string
	UpdatedAt time.Time
}

// Platforms push can reach.
const (
	PlatformIOS     = "ios"
	PlatformAndroid = "android"
)

// Provider is a sign-in method linked to an account.
type Provider struct {
	// Name and Subject are the provider's own: "google" and the sub
	// claim it issues, which is stable where an email address is not.
	Name    string
	Subject string
	// RefreshToken is Apple's, banked at sign-in because deleting an
	// account has to revoke the grant behind it and the authorization
	// code it comes from dies within minutes.
	RefreshToken string
	LinkedAt     time.Time
}
