// Package invite is the invite/join-request flow: Store is the interface
// domain logic depends on; implementations live in subpackages, one per
// backing technology (see invite/dynamodb). Ephemeral, per-individual,
// TTL'd storage: rows expire on their own rather than being deleted the
// moment they're read, so a device that polls late doesn't lose its
// response. Invites are its first consumer, not its only intended one —
// any future one-shot, per-person exchange can reuse the same shape. The
// relay only ever stores and forwards ciphertext here, same blind-relay
// property as everything else in this system. See invite/http for the
// HTTP-facing half.
package invite

import (
	"context"
	"errors"
)

// ErrJoinRequestNotFound is what ApproveJoinRequest returns when
// (inviteTag, requesterID) has no row to approve — never made, or already
// aged out under TTL. Callers (see invite/http) use this to distinguish
// "nothing to approve" from a genuine storage failure.
var ErrJoinRequestNotFound = errors.New("invite: join request not found")

// ErrInviteExists is what CreateInvite returns when inviteTag already has
// an invite row. The tag is derived from the code, so anyone holding the
// code could otherwise overwrite the preview, including its
// createdByPublicKey, and sign approvals that verify against it.
var ErrInviteExists = errors.New("invite: invite already exists")

// JoinRequest is one requester's row under an invite — created by the
// requester, later updated in place by the invite's creator once approved.
type JoinRequest struct {
	RequesterID       string
	EncryptedRequest  []byte
	EncryptedApproval []byte // nil until approved
	CreatedAt         int64
}

// Store persists one table's worth of invite rows: an "invite" row per
// invite tag, plus one "join request" row per requester under that tag.
// Every row is ephemeral (TTL'd by the backing store — see
// config.InviteRetentionDays), never circle
// content itself.
type Store interface {
	// CreateInvite writes the sk="invite" row — the one proactive server
	// write in the whole flow, done once at invite-creation time. Named for
	// what the row *is* (the invite's existence, server-side), not
	// "PutPreview" — the fact that its content happens to be an encrypted
	// preview payload (name + thumbnail) is a client-side encoding detail.
	// Create-only: ErrInviteExists if the row is already there.
	CreateInvite(ctx context.Context, inviteTag string, encryptedPreview []byte) error
	// GetInvite returns nil, nil if inviteTag has no invite row (never
	// created, or aged out under TTL).
	GetInvite(ctx context.Context, inviteTag string) ([]byte, error)
	// PutJoinRequest creates the requester's row if it doesn't already
	// exist. Create-if-not-exists, not overwrite — the requester's own id
	// is randomly chosen, so calling this again with the same
	// (inviteTag, requesterID) is always a retry of the same submission,
	// never a legitimate second request, and must converge rather than
	// error.
	PutJoinRequest(ctx context.Context, inviteTag, requesterID string, encryptedRequest []byte) error
	// ListJoinRequests returns every pending or approved request under
	// inviteTag, for the creator's device to scan on each check.
	ListJoinRequests(ctx context.Context, inviteTag string) ([]JoinRequest, error)
	// GetJoinRequest returns nil, nil if this requester has no row under
	// inviteTag.
	GetJoinRequest(ctx context.Context, inviteTag, requesterID string) (*JoinRequest, error)
	// ApproveJoinRequest sets the sealed-box-encrypted approval payload on
	// an existing request row. Returns ErrJoinRequestNotFound if the row
	// doesn't exist — approving a request that was never made (or already
	// aged out) is a caller error, not silently creating a fresh row.
	ApproveJoinRequest(ctx context.Context, inviteTag, requesterID string, encryptedApproval []byte) error
	// DeleteJoinRequest removes a requester's row — the invite's creator
	// dismissing a request ("not now"), permanently, before it's ever
	// approved. Idempotent: deleting an already-gone or already-expired
	// row succeeds, doesn't error, same convention as auth's
	// DeleteSession.
	DeleteJoinRequest(ctx context.Context, inviteTag, requesterID string) error
}
