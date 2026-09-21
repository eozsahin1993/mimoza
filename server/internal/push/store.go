// Package push is mobile push notifications, addressed by routing id, not
// account: the relay holds no link between the two, so there is nothing
// to nest under. Store is the interface domain logic depends on for push
// routing state; implementations live in subpackages, one per backing
// technology (see push/dynamodb). Fanout and routing logic live in
// service.go — payloads arrive as ciphertext and are forwarded untouched
// — platform dispatch in push/apns and push/fcm, and the HTTP-facing half
// in push/http.
//
// No account ids, circle ids, or lists of which routing ids belong
// together, anywhere in here. There is deliberately no method that could
// write one: a durable circle-to-routing-id table would hand the relay
// exactly the group membership this design exists to keep it blind to.
package push

import (
	"context"
	"errors"
)

// ErrPushRoutingNotFound means a routing id has no prefs row. Distinct from a
// storage failure so a send to a stale id skips rather than fails.
var ErrPushRoutingNotFound = errors.New("push: routing id not registered")

// ErrNotOwner means a write presented an owner token that doesn't match the
// row's OwnerHash. Routing ids are shared on purpose (every member reads
// them from the roster), so knowing one must not be enough to change it.
var ErrNotOwner = errors.New("push: not the owner of this routing id")

// MaxCategory is what CategoryMask's bitmask encoding fits. Nothing here
// knows what any category means.
const MaxCategory = 62

// Prefs is one routing id's control row.
type Prefs struct {
	PushFanoutHash []byte
	// Who may change this row and its devices; see OwnerHash.
	OwnerHash []byte
	// Enabled-bits, not disabled: a row written before a category existed
	// has that bit unset, so a new category stays off until the device
	// re-registers rather than switching itself on for everyone.
	CategoryMask int64
	// Never compared during a send — the hash is what authorizes.
	KeyVersion int64
	// Set while this account has silenced the circle. A flag rather than
	// deleting the row: silencing is account-wide, so it cannot live on a
	// device row, and delete-then-recreate would make a failed unsilence
	// leave someone unreachable with nothing to notice.
	Silenced bool
}

// Device is one device's delivery row. PushToken arrives already
// encrypted; nothing here encrypts or decrypts.
type Device struct {
	DeviceID  string
	PushToken []byte
	Platform  string
	Enabled   bool
}

// Store persists one prefs row per routing id, plus a device row per
// device wanting delivery under it.
type Store interface {
	// PutPrefs writes prefs.OwnerHash along with the rest. A new row is
	// claimed; an existing one owned by a different hash returns
	// ErrNotOwner — atomically, so two first writes can't both win.
	PutPrefs(ctx context.Context, pushRoutingID string, prefs Prefs) error
	// SetSilenced flips just that flag, leaving the hash and categories
	// alone — no re-derivation, and unsilencing needs no content key.
	// Returns ErrPushRoutingNotFound if there is no prefs row.
	SetSilenced(ctx context.Context, pushRoutingID string, silenced bool) error
	GetPrefs(ctx context.Context, pushRoutingID string) (*Prefs, error)
	// Independent of PutPrefs: re-registering a rotated push token must not
	// restate the account's categories.
	PutDevice(ctx context.Context, pushRoutingID string, device Device) error
	// Returns disabled rows too — a caller can then tell "no devices" from
	// "all muted" without a second read.
	ListDevices(ctx context.Context, pushRoutingID string) ([]Device, error)
	DeleteDevice(ctx context.Context, pushRoutingID, deviceID string) error
	// Prefs and every device row with it. Idempotent.
	DeleteRouting(ctx context.Context, pushRoutingID string) error
}
