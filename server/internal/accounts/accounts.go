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
	// ProfilePictureID names the picture in the bucket, under
	// ProfilePictureKey. Like the name it is stored as uploaded, not
	// sealed: it is shown to people who hold no circle key yet (an admin
	// answering a join request, someone opening an invite), so there is
	// nothing it could be sealed to. A changed picture is a new id, never
	// bytes rewritten in place, so every cached copy stays right.
	ProfilePictureID    string
	ProfilePictureSetAt time.Time
	// PublicKey is X25519, for sealing.
	PublicKey      []byte
	PublicKeySetAt time.Time
	CreatedAt      time.Time
}

// ProfileBlobPrefix is where an account's own objects live in the bucket.
// It sits outside every circle's prefix, so a circle sweep never touches
// it and deleting the account has to sweep it itself.
func ProfileBlobPrefix(accountID string) string { return "account/" + accountID + "/" }

// ProfilePictureKey is one picture's object key. Every slice that signs
// or deletes a picture derives it from here, so they cannot drift apart.
func ProfilePictureKey(accountID, pictureID string) string {
	return ProfileBlobPrefix(accountID) + "picture/" + pictureID
}

// Device is one phone this account is signed in on. Push goes to these,
// and to nothing else.
type Device struct {
	DeviceID  string
	PushToken string
	Platform  string
	// Locale is what language the device wants its notifications in.
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
	// account has to revoke the grant behind it.
	RefreshToken string
	LinkedAt     time.Time
}

// DeviceLink is one in-flight handoff of an account's keypair, from a
// phone that has it to one that does not. Both ends are the same
// account, and a session lives in that account's partition, so the key
// shape is the access check.
type DeviceLink struct {
	SessionID string
	// Throwaway, minted by the waiting phone for this handoff. It travels
	// in the QR code rather than from here, so a relay that substituted
	// its own key would not be the one sealed to.
	PublicKey []byte
	// Empty until the other phone answers.
	SealedKeypair []byte
	CreatedAt     time.Time
	DeliveredAt   time.Time
	ExpiresAt     time.Time
}

func (l DeviceLink) Delivered() bool { return len(l.SealedKeypair) > 0 }

// DefaultDeviceLinkRetention is long enough to go and find the other
// phone. An open session holds only a public key, and once answered, a
// blob only the waiting phone can open.
const DefaultDeviceLinkRetention = time.Hour

// X25519KeyLength is what this relay will accept as a public key. It does
// no curve arithmetic itself, but it does refuse a key that cannot be one.
const X25519KeyLength = 32
