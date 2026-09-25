package accounts

import (
	"errors"
	"net/http"

	"mimoza-relay/internal/blobs"
)

var (
	ErrNotFound = errors.New("accounts: no such account")
	// ErrProviderLinked means this sign-in already resolves to another
	// account — linking it again would split one person in two.
	ErrProviderLinked = errors.New("accounts: this sign-in belongs to another account")
	// ErrLinkAnswered means a device link already holds a sealed keypair.
	// First answer wins.
	ErrLinkAnswered = errors.New("accounts: this device link was already answered")
)

// Status maps a column error to what the caller sees, in one place so
// every slice answers the same failure the same way. Anything else is a
// fault of ours, not theirs.
func Status(err error) (int, string) {
	switch {
	case err == nil:
		return http.StatusOK, ""
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, ErrProviderLinked):
		return http.StatusConflict, err.Error()
	case errors.Is(err, ErrLinkAnswered):
		return http.StatusConflict, err.Error()
	case errors.Is(err, blobs.ErrExists):
		return http.StatusConflict, err.Error()
	default:
		return http.StatusInternalServerError, "something went wrong"
	}
}
