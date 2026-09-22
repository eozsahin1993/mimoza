package dynamo

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/dynamoutil"
)

// RecentComments is how many comments ride on a post for the wall to
// render without fetching. One today: at one, the write is a plain SET
// of the newest, so concurrent comments resolve to whichever commits
// last — which is the newest. Above one it needs a prepend and a trim,
// which converge but are not exact in between (see docs/RELAY_DESIGN.md).
const RecentComments = 1

// Entry attribute names, beyond the ones every row shares.
const (
	AttrType           = "type"
	AttrAuthorID       = "authorId"
	AttrCiphertext     = "ciphertext"
	AttrHasBlob        = "hasBlob"
	AttrVisibility     = "visibility"
	AttrCommentCount   = "commentCount"
	AttrReactionCounts = "reactionCounts"
	// AttrReactors holds one entry per member who has reacted, account id
	// to tag. Bounded by the circle's member cap, and a read projects only
	// the caller's own entry, so a page never carries the whole map.
	AttrReactors = "reactors"
	// AttrCommenters is the same shape for comments: who has commented,
	// so a card can say so without reading the comments themselves.
	AttrCommenters = "commenters"
	// AttrMemberCount is kept on the circle so the member cap can be a
	// condition rather than a count read beforehand, which two admins
	// approving at once would both pass.
	AttrMemberCount = "memberCount"
	// AttrAdminCount is what keeps a circle governable: demoting or
	// leaving is conditioned on it, so two admins going at once cannot
	// both pass a check that read the roster before either wrote.
	AttrAdminCount    = "adminCount"
	AttrRecent        = "recentComments"
	AttrReceivedAt    = "receivedAt"
	AttrDeletedAt     = "deletedAt"
	AttrEvent         = "event"
	AttrSubjectID     = "subjectId"
	AttrSubjectName   = "subjectName"
	AttrTag           = "tag"
	AttrParentComment = "parentCommentId"
	AttrCommentID     = "commentId"
)

// MintID is for rows the relay creates rather than the client: activity
// entries. Client-created rows keep the id their author chose, which is
// what makes a retried write idempotent.
func MintID() string {
	buf := make([]byte, 16)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func PostItem(circleID string, entry circles.Entry) map[string]types.AttributeValue {
	item := map[string]types.AttributeValue{
		dynamoutil.PKAttr:  Str(CirclePK(circleID)),
		dynamoutil.SKAttr:  Str(EntryKey(entry.ID)),
		AttrType:           Str(circles.TypePost),
		AttrAuthorID:       Str(entry.AuthorID),
		AttrKeyVersion:     Num(entry.KeyVersion),
		AttrCiphertext:     Binary(entry.Ciphertext),
		AttrHasBlob:        Bool(entry.HasBlob),
		AttrVisibility:     Str(entry.Visibility),
		AttrCommentCount:   Num(0),
		AttrReactionCounts: &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
		AttrReactors:       &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
		AttrCommenters:     &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
		AttrReceivedAt:     Millis(entry.ReceivedAt),
		AttrUpdatedAt:      Millis(entry.ReceivedAt),
		ByTypeReceivedKey:  Str(circles.IndexKey(circles.TypePost, entry.ReceivedAt, entry.ID)),
		ByTypeUpdatedKey:   Str(circles.IndexKey(circles.TypePost, entry.ReceivedAt, entry.ID)),
	}
	return item
}

func ActivityItem(circleID string, entry circles.Entry) map[string]types.AttributeValue {
	if entry.ID == "" {
		entry.ID = MintID()
	}
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: Str(CirclePK(circleID)),
		dynamoutil.SKAttr: Str(EntryKey(entry.ID)),
		AttrType:          Str(circles.TypeActivity),
		AttrEvent:         Str(entry.Event),
		AttrAuthorID:      Str(entry.AuthorID),
		AttrSubjectID:     Str(entry.SubjectID),
		AttrSubjectName:   Str(entry.SubjectName),
		AttrReceivedAt:    Millis(entry.ReceivedAt),
		ByTypeReceivedKey: Str(circles.IndexKey(circles.TypeActivity, entry.ReceivedAt, entry.ID)),
	}
}

func EntryFrom(item map[string]types.AttributeValue) circles.Entry {
	entry := circles.Entry{
		ID:         strings.TrimPrefix(StringAt(item, dynamoutil.SKAttr), EntrySK),
		Type:       StringAt(item, AttrType),
		AuthorID:   StringAt(item, AttrAuthorID),
		ReceivedAt: TimeAt(item, AttrReceivedAt),
	}
	if entry.Type == circles.TypeActivity {
		entry.Event = StringAt(item, AttrEvent)
		entry.SubjectID = StringAt(item, AttrSubjectID)
		entry.SubjectName = StringAt(item, AttrSubjectName)
		return entry
	}

	entry.KeyVersion = IntAt(item, AttrKeyVersion)
	entry.Ciphertext = BytesAt(item, AttrCiphertext)
	entry.HasBlob = BoolAt(item, AttrHasBlob)
	entry.Visibility = StringAt(item, AttrVisibility)
	entry.CommentCount = IntAt(item, AttrCommentCount)
	entry.ReactionCounts = CountsFrom(item)
	entry.RecentComments = RecentFrom(item, entry.ID)
	entry.MyTag = TagOf(item)
	entry.ICommented = HasCommented(item)
	entry.UpdatedAt = TimeAt(item, AttrUpdatedAt)
	entry.DeletedAt = TimeAt(item, AttrDeletedAt)
	return entry
}

func CountsFrom(item map[string]types.AttributeValue) map[string]int64 {
	raw, ok := item[AttrReactionCounts].(*types.AttributeValueMemberM)
	if !ok {
		return nil
	}
	counts := make(map[string]int64, len(raw.Value))
	for tag, value := range raw.Value {
		n, ok := value.(*types.AttributeValueMemberN)
		if !ok {
			continue
		}
		parsed, err := strconv.ParseInt(n.Value, 10, 64)
		// A tag that has been added and removed back to zero stays in the
		// map; clients hide it rather than the relay rewriting the map.
		if err != nil || parsed == 0 {
			continue
		}
		counts[tag] = parsed
	}
	return counts
}

func RecentItem(comment circles.Comment) types.AttributeValue {
	return &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{
		AttrCommentID:  Str(comment.ID),
		AttrAuthorID:   Str(comment.AuthorID),
		AttrKeyVersion: Num(comment.KeyVersion),
		AttrCiphertext: Binary(comment.Ciphertext),
		AttrReceivedAt: Millis(comment.ReceivedAt),
	}}
}

func RecentFrom(item map[string]types.AttributeValue, postID string) []circles.Comment {
	raw, ok := item[AttrRecent].(*types.AttributeValueMemberL)
	if !ok {
		return nil
	}
	comments := make([]circles.Comment, 0, len(raw.Value))
	for _, value := range raw.Value {
		fields, ok := value.(*types.AttributeValueMemberM)
		if !ok {
			continue
		}
		comments = append(comments, circles.Comment{
			ID:         StringAt(fields.Value, AttrCommentID),
			PostID:     postID,
			AuthorID:   StringAt(fields.Value, AttrAuthorID),
			KeyVersion: IntAt(fields.Value, AttrKeyVersion),
			Ciphertext: BytesAt(fields.Value, AttrCiphertext),
			ReceivedAt: TimeAt(fields.Value, AttrReceivedAt),
		})
	}
	return comments
}

func SortByReceivedAt(comments []circles.Comment) {
	for i := 1; i < len(comments); i++ {
		for j := i; j > 0 && comments[j].ReceivedAt.Before(comments[j-1].ReceivedAt); j-- {
			comments[j], comments[j-1] = comments[j-1], comments[j]
		}
	}
}

func CircleFrom(circleID string, item map[string]types.AttributeValue) circles.Circle {
	return circles.Circle{
		ID:            circleID,
		Name:          StringAt(item, AttrName),
		CoverID:       StringAt(item, AttrCoverID),
		KeyVersion:    IntAt(item, AttrKeyVersion),
		RosterVersion: IntAt(item, AttrRosterVersion),
		LastEntryAt:   TimeAt(item, AttrLastEntryAt),
		CreatedBy:     StringAt(item, AttrCreatedBy),
		CreatedAt:     TimeAt(item, AttrCreatedAt),
	}
}

func MemberItem(circleID string, member circles.Member, joinedAt time.Time) map[string]types.AttributeValue {
	if member.JoinedAt.IsZero() {
		member.JoinedAt = joinedAt
	}
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: Str(CirclePK(circleID)),
		dynamoutil.SKAttr: Str(MemberKey(member.AccountID)),
		// Carried as its own attribute because the by-account index keys
		// on it; the sort key holds it too, but an index cannot read part
		// of a key.
		AttrAccountID:   Str(member.AccountID),
		AttrRole:        Str(member.Role),
		AttrNotifyLevel: Str(member.NotifyLevel),
		AttrNeedsRewrap: Bool(member.NeedsRewrap),
		AttrJoinedAt:    Millis(member.JoinedAt),
	}
}

func MemberFrom(item map[string]types.AttributeValue) circles.Member {
	return circles.Member{
		AccountID:   StringAt(item, AttrAccountID),
		Role:        StringAt(item, AttrRole),
		NotifyLevel: StringAt(item, AttrNotifyLevel),
		NeedsRewrap: BoolAt(item, AttrNeedsRewrap),
		JoinedAt:    TimeAt(item, AttrJoinedAt),
	}
}

// SealedKeysAttr stores one member's keys as a map of version to sealed
// bytes: every access is "all of this member's versions", and a map lets
// a rotation add one without reading the rest.
func SealedKeysAttr(keys circles.SealedKeys) types.AttributeValue {
	attr := make(map[string]types.AttributeValue, len(keys))
	for version, sealed := range keys {
		attr[strconv.FormatInt(version, 10)] = Binary(sealed)
	}
	return &types.AttributeValueMemberM{Value: attr}
}

func SealedKeysFrom(item map[string]types.AttributeValue) circles.SealedKeys {
	raw, ok := item[AttrKeys].(*types.AttributeValueMemberM)
	if !ok {
		return circles.SealedKeys{}
	}
	keys := make(circles.SealedKeys, len(raw.Value))
	for version, sealed := range raw.Value {
		parsed, err := strconv.ParseInt(version, 10, 64)
		if err != nil {
			continue
		}
		if value, ok := sealed.(*types.AttributeValueMemberB); ok {
			keys[parsed] = value.Value
		}
	}
	return keys
}

// expiresAt is in seconds, not milliseconds: DynamoDB's own TTL reads it
// and expects Unix seconds.
func ExpiryFrom(item map[string]types.AttributeValue) time.Time {
	seconds := IntAt(item, AttrExpiresAt)
	if seconds == 0 {
		return time.Time{}
	}
	return time.Unix(seconds, 0)
}

// TagOf and HasCommented read the one entry a projected read asks for:
// the caller's own. A read that projected the whole map would answer for
// whoever DynamoDB returned first, so both are only meaningful on a read
// that asked for a single account.
func TagOf(item map[string]types.AttributeValue) string {
	raw, ok := item[AttrReactors].(*types.AttributeValueMemberM)
	if !ok || len(raw.Value) != 1 {
		return ""
	}
	for _, tag := range raw.Value {
		if value, ok := tag.(*types.AttributeValueMemberS); ok {
			return value.Value
		}
	}
	return ""
}

func HasCommented(item map[string]types.AttributeValue) bool {
	raw, ok := item[AttrCommenters].(*types.AttributeValueMemberM)
	return ok && len(raw.Value) == 1
}
