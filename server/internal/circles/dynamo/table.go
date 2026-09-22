package dynamo

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/util/dynamoutil"
)

// Table is the one table every slice writes to, one partition per
// circle. It carries no queries of its own: a slice owns the reads and
// writes it issues, and shares only the key shapes and item encoding
// here, which a comment updating its post's row and an approval writing
// a membership both depend on.
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

// Key prefixes. A circle's rows all share its partition; the sort key is
// what says which kind of row this is, and sorts the kinds into
// contiguous ranges.
const (
	CirclePKPrefix = "circle#"
	InvitePKPrefix = "invite#"

	MetaSK     = "meta"
	MemberSK   = "member#"
	KeySK      = "key#"
	InviteSK   = "invite#"
	RequestSK  = "request#"
	EntrySK    = "entry#"
	ChildSK    = "child#"
	CommentSeg = "#comment#"
	ReactSeg   = "#reaction#"
)

func CirclePK(circleID string) string { return CirclePKPrefix + circleID }
func InvitePK(code string) string     { return InvitePKPrefix + code }

func MemberKey(accountID string) string    { return MemberSK + accountID }
func SealedKeyKey(accountID string) string { return KeySK + accountID }
func InviteKey(code string) string         { return InviteSK + code }
func RequestKey(requestID string) string   { return RequestSK + requestID }
func EntryKey(entryID string) string       { return EntrySK + entryID }

func CommentKey(postID, commentID string) string {
	return ChildSK + postID + CommentSeg + commentID
}

func ReactionKey(postID, accountID string) string {
	return ChildSK + postID + ReactSeg + accountID
}

// ChildPrefix is every comment and reaction on one post — what the post
// screen fetches in a single query.
func ChildPrefix(postID string) string { return ChildSK + postID + "#" }

func (t *Table) Key(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: Str(pk),
		dynamoutil.SKAttr: Str(sk),
	}
}

// Attribute names. Shared by the item writers and readers below, so a
// typo cannot make one write a field the other never reads.
const (
	AttrName          = "name"
	AttrCoverID       = "coverId"
	AttrKeyVersion    = "keyVersion"
	AttrRosterVersion = "rosterVersion"
	AttrLastEntryAt   = "lastEntryAt"
	AttrCreatedBy     = "createdBy"
	AttrCreatedAt     = "createdAt"
	AttrAccountID     = "accountId"
	AttrRole          = "role"
	AttrNotifyLevel   = "notifyLevel"
	AttrNeedsRewrap   = "needsRewrap"
	AttrJoinedAt      = "joinedAt"
	AttrKeys          = "keys"
	AttrUpdatedAt     = "updatedAt"
	AttrExpiresAt     = "expiresAt"
	AttrPublicKey     = "publicKey"
	AttrRequesterID   = "requesterId"
	AttrStatus        = "status"
	AttrCircleID      = "circleId"
)

func Str(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }

func Num(v int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(v, 10)}
}

func Binary(v []byte) types.AttributeValue { return &types.AttributeValueMemberB{Value: v} }

func Bool(v bool) types.AttributeValue { return &types.AttributeValueMemberBOOL{Value: v} }

// Millis writes a time as an int64 of milliseconds, matching the
// resolution the index keys sort on.
func Millis(t time.Time) types.AttributeValue { return Num(t.UnixMilli()) }

func TimeAt(item map[string]types.AttributeValue, attr string) time.Time {
	v, err := dynamoutil.AttrInt(item, attr)
	if err != nil || v == 0 {
		return time.Time{}
	}
	return time.UnixMilli(v)
}

func IntAt(item map[string]types.AttributeValue, attr string) int64 {
	v, _ := dynamoutil.AttrInt(item, attr)
	return v
}

func StringAt(item map[string]types.AttributeValue, attr string) string {
	v, _ := dynamoutil.AttrString(item, attr)
	return v
}

func BoolAt(item map[string]types.AttributeValue, attr string) bool {
	return dynamoutil.AttrBool(item, attr)
}

func BytesAt(item map[string]types.AttributeValue, attr string) []byte {
	v, _ := dynamoutil.AttrBytes(item, attr)
	return v
}

// ConditionFailed reports whether a write lost its condition — the row
// already existed, or the value it was written against has moved.
func ConditionFailed(err error) bool {
	var failed *types.ConditionalCheckFailedException
	return errors.As(err, &failed)
}

// CancelledFor returns the reason DynamoDB gave for the item at index i
// of a transaction, or "" if the failure was not a cancellation. It is
// what turns "the transaction failed" into which condition failed, so a
// caller can tell a stale key version from a missing member.
func CancelledFor(err error, i int) string {
	var cancelled *types.TransactionCanceledException
	if !errors.As(err, &cancelled) || i >= len(cancelled.CancellationReasons) {
		return ""
	}
	return aws.ToString(cancelled.CancellationReasons[i].Code)
}

const ConditionalCheckFailed = "ConditionalCheckFailed"

// Retryable reports whether every reason a transaction gave is
// contention rather than a failed condition: worth another attempt,
// since the write itself was valid.
func Retryable(err error) bool {
	var cancelled *types.TransactionCanceledException
	if !errors.As(err, &cancelled) {
		return false
	}
	conflicted := false
	for _, reason := range cancelled.CancellationReasons {
		switch aws.ToString(reason.Code) {
		case "None":
		case "TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded":
			conflicted = true
		default:
			return false
		}
	}
	return conflicted
}

// MaxAttempts bounds the retries above. Contention here is two members
// writing to one post, not a queue of writers, so a handful is plenty.
const MaxAttempts = 5

// WithRetry runs a transaction, retrying only DynamoDB's own contention.
func WithRetry(write func() error) error {
	return WithRetryOn(nil, write)
}

// WithRetryOn also reruns when alsoRetry says the failure was a stale
// read of the caller's own — a condition written against a value that
// moved, which rereading resolves. Everything else is left alone: a
// failed condition is usually an answer, not a hiccup.
func WithRetryOn(alsoRetry func(error) bool, write func() error) error {
	var err error
	for attempt := range MaxAttempts {
		err = write()
		if err == nil {
			return nil
		}
		if !Retryable(err) && (alsoRetry == nil || !alsoRetry(err)) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 10 * time.Millisecond)
	}
	return fmt.Errorf("gave up after %d attempts: %w", MaxAttempts, err)
}
