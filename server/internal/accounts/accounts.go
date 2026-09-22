// Package accounts is who is using the relay: one account per person,
// the profile every circle they are in shows, the devices push reaches
// them on, and the sign-ins that resolve to them.
//
// An account id is the relay's own, minted at first sign-in. A provider
// subject is a lookup onto it, not the id itself, so a second sign-in
// method can be linked later without the account changing underneath
// every circle it belongs to.
package accounts

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound = errors.New("accounts: no such account")
	// ErrProviderLinked means this sign-in already resolves to another
	// account — linking it again would split one person in two.
	ErrProviderLinked = errors.New("accounts: this sign-in belongs to another account")
)

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

// Store is what the relay does with an account.
type Store interface {
	// Resolve finds the account a sign-in belongs to, minting one on
	// first sight. The bool says which happened, so a caller can tell a
	// returning person from a new one.
	Resolve(ctx context.Context, provider Provider) (accountID string, created bool, err error)
	GetProfile(ctx context.Context, accountID string) (Profile, error)
	SetProfile(ctx context.Context, accountID, name, avatarKey string) error
	SetPublicKey(ctx context.Context, accountID string, publicKey []byte) error

	PutDevice(ctx context.Context, accountID string, device Device) error
	DeleteDevice(ctx context.Context, accountID, deviceID string) error
	ListDevices(ctx context.Context, accountID string) ([]Device, error)

	Providers(ctx context.Context, accountID string) ([]Provider, error)
	SaveRefreshToken(ctx context.Context, accountID, provider, subject, token string) error
	Delete(ctx context.Context, accountID string) error
}

// Reader is the part other columns need: circles resolves a roster's
// names and public keys through it, and push its devices.
type Reader interface {
	GetProfile(ctx context.Context, accountID string) (Profile, error)
	ListDevices(ctx context.Context, accountID string) ([]Device, error)
}
