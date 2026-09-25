// Package dynamo is the accounts column's storage: one partition per
// account, plus a tiny partition per sign-in that points at it.
package dynamo

import (
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/util/dynamoutil"
)

// Table is the accounts table every slice writes to. It carries the key
// shapes and the item encoding, the two reads other columns need, and
// resolving a sign-in — which is nobody's slice, since both sign-in
// routes and the test relay go through the same mint-or-find.
type Table struct {
	Client *dynamodb.Client
	Name   string
	// Now is the relay's clock, replaced in tests that need to place a
	// write at a particular moment.
	Now func() time.Time
}

func NewTable(client *dynamodb.Client, name string) *Table {
	return &Table{Client: client, Name: name, Now: time.Now}
}

// Key shapes. An account owns one partition; a sign-in owns its own,
// holding nothing but the account it resolves to.
const (
	AccountPKPrefix  = "account#"
	ProviderPKPrefix = "provider#"

	ProfileSK    = "profile"
	DeviceSK     = "device#"
	ProviderSK   = "provider#"
	LookupSK     = "lookup"
	DeviceLinkSK = "devicelink#"
)

func AccountPK(accountID string) string { return AccountPKPrefix + accountID }

func DeviceKey(deviceID string) string { return DeviceSK + deviceID }

// DeviceLinkKey puts a handoff inside the account's own partition, which
// is the access check: only a device signed in as that account can name it.
func DeviceLinkKey(sessionID string) string { return DeviceLinkSK + sessionID }

// ProviderID is how a sign-in is named in both places it appears: the
// provider and the subject it issued, which is stable where an email
// address is not.
func ProviderID(provider, subject string) string { return provider + ":" + subject }

func ProviderKey(provider, subject string) string { return ProviderSK + ProviderID(provider, subject) }

func ProviderPK(provider, subject string) string {
	return ProviderPKPrefix + ProviderID(provider, subject)
}

func (t *Table) Key(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: dynamoutil.Str(pk),
		dynamoutil.SKAttr: dynamoutil.Str(sk),
	}
}

// Attribute names. The profile, device and sign-in rows share a
// partition, so these are named per row kind rather than pooled.
const (
	AttrAccountID    = "accountId"
	AttrName         = "name"
	AttrPublicKey    = "publicKey"
	AttrPublicKeyAt  = "publicKeySetAt"
	AttrCreatedAt    = "createdAt"
	AttrPushToken    = "pushToken"
	AttrPlatform     = "platform"
	AttrLocale       = "locale"
	AttrUpdatedAt    = "updatedAt"
	AttrRefreshToken = "refreshToken"
	AttrLinkedAt     = "linkedAt"

	AttrSealedKeypair = "sealedKeypair"
	AttrDeliveredAt   = "deliveredAt"
	// TTL attribute, epoch seconds. DynamoDB sweeps lazily, so reads check
	// it rather than trusting a row's absence.
	AttrExpiresAt = "expiresAt"
)
