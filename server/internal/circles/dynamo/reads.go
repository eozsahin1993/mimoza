package dynamo

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/util/dynamoutil"
)

func (t *Table) GetCircle(ctx context.Context, circleID string) (circles.Circle, error) {
	out, err := t.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(t.Name),
		Key:            t.Key(CirclePK(circleID), MetaSK),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return circles.Circle{}, err
	}
	if out.Item == nil {
		return circles.Circle{}, circles.ErrCircleNotFound
	}
	return CircleFrom(circleID, out.Item), nil
}

func (t *Table) GetMember(ctx context.Context, circleID, accountID string) (circles.Member, error) {
	out, err := t.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(t.Name),
		Key:            t.Key(CirclePK(circleID), MemberKey(accountID)),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return circles.Member{}, err
	}
	if out.Item == nil {
		return circles.Member{}, circles.ErrNotMember
	}
	return MemberFrom(out.Item), nil
}

func (t *Table) ListMembers(ctx context.Context, circleID string) ([]circles.Member, error) {
	paginator := dynamodb.NewQueryPaginator(t.Client, &dynamodb.QueryInput{
		TableName:              aws.String(t.Name),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     dynamoutil.Str(CirclePK(circleID)),
			":prefix": dynamoutil.Str(MemberSK),
		},
	})

	var roster []circles.Member
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			roster = append(roster, MemberFrom(item))
		}
	}
	return roster, nil
}

func (t *Table) GetSealedKeys(ctx context.Context, circleID, accountID string) (circles.SealedKeys, error) {
	out, err := t.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(t.Name),
		Key:            t.Key(CirclePK(circleID), SealedKeyKey(accountID)),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return circles.SealedKeys{}, nil
	}
	return SealedKeysFrom(out.Item), nil
}

// TouchCircle is the lastEntryAt bump every write carries: a hint to a
// device that this circle has something new, not a guarantee it has
// everything (that is CountEntries).
func (t *Table) TouchCircle(circleID string, at time.Time) *types.Update {
	return &types.Update{
		TableName:                 aws.String(t.Name),
		Key:                       t.Key(CirclePK(circleID), MetaSK),
		UpdateExpression:          aws.String("SET " + AttrLastEntryAt + " = :at"),
		ConditionExpression:       aws.String("attribute_exists(pk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":at": dynamoutil.Millis(at)},
	}
}

// Post reads one entry, with the reader's own reaction attached — the
// wall needs it to show whether you reacted, and it is one extra read
// rather than a second round trip from the client.
func (t *Table) GetPost(ctx context.Context, circleID, postID, readerID string) (circles.Entry, error) {
	projection, names := ProjectionFor(readerID)
	out, err := t.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:                aws.String(t.Name),
		Key:                      t.Key(CirclePK(circleID), EntryKey(postID)),
		ConsistentRead:           aws.Bool(true),
		ProjectionExpression:     projection,
		ExpressionAttributeNames: names,
	})
	if err != nil {
		return circles.Entry{}, err
	}
	if out.Item == nil {
		return circles.Entry{}, circles.ErrEntryNotFound
	}

	return EntryFrom(out.Item), nil
}

func (t *Table) GetReaction(ctx context.Context, circleID, postID, accountID string) (*circles.Reaction, error) {
	out, err := t.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(t.Name),
		Key:            t.Key(CirclePK(circleID), ReactionKey(postID, accountID)),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil || out.Item == nil {
		return nil, err
	}
	return &circles.Reaction{
		AccountID:  accountID,
		PostID:     postID,
		Tag:        dynamoutil.StringAt(out.Item, AttrTag),
		KeyVersion: dynamoutil.IntAt(out.Item, AttrKeyVersion),
		Ciphertext: dynamoutil.BytesAt(out.Item, AttrCiphertext),
		ReceivedAt: dynamoutil.TimeAt(out.Item, AttrReceivedAt),
	}, nil
}

// Children is everything under one post — what the post screen fetches
// when it opens. One query: comments and reactions share a key prefix.
func (t *Table) ListChildren(ctx context.Context, circleID, postID string) ([]circles.Comment, []circles.Reaction, error) {
	paginator := dynamodb.NewQueryPaginator(t.Client, &dynamodb.QueryInput{
		TableName:              aws.String(t.Name),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     dynamoutil.Str(CirclePK(circleID)),
			":prefix": dynamoutil.Str(ChildPrefix(postID)),
		},
	})

	var comments []circles.Comment
	var reactions []circles.Reaction
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, nil, err
		}
		for _, item := range page.Items {
			sk := dynamoutil.StringAt(item, dynamoutil.SKAttr)
			switch {
			case strings.Contains(sk, CommentSeg):
				comments = append(comments, circles.Comment{
					ID:              sk[strings.Index(sk, CommentSeg)+len(CommentSeg):],
					PostID:          postID,
					AuthorID:        dynamoutil.StringAt(item, AttrAuthorID),
					ParentCommentID: dynamoutil.StringAt(item, AttrParentComment),
					KeyVersion:      dynamoutil.IntAt(item, AttrKeyVersion),
					Ciphertext:      dynamoutil.BytesAt(item, AttrCiphertext),
					ReceivedAt:      dynamoutil.TimeAt(item, AttrReceivedAt),
					DeletedAt:       dynamoutil.TimeAt(item, AttrDeletedAt),
				})
			case strings.Contains(sk, ReactSeg):
				reactions = append(reactions, circles.Reaction{
					AccountID:  sk[strings.Index(sk, ReactSeg)+len(ReactSeg):],
					PostID:     postID,
					Tag:        dynamoutil.StringAt(item, AttrTag),
					KeyVersion: dynamoutil.IntAt(item, AttrKeyVersion),
					Ciphertext: dynamoutil.BytesAt(item, AttrCiphertext),
					ReceivedAt: dynamoutil.TimeAt(item, AttrReceivedAt),
				})
			}
		}
	}

	// Comments are keyed by id, so they come back in id order; the wall
	// and the screen both want them in the order they were written.
	SortByReceivedAt(comments)
	return comments, reactions, nil
}

// ProjectionFor is what a post read asks for: every field a card needs,
// and of the two per-member maps only the caller's own entry — so a page
// of 200 posts carries 200 tags rather than every reactor in the circle.
// A reader-less read (a write handing its post back) skips them both.
func ProjectionFor(readerID string) (*string, map[string]string) {
	// Every field goes through a placeholder: several are reserved words
	// in DynamoDB's expression language (type, status, name among them),
	// and naming one directly fails the whole read.
	fields := []string{
		"pk", "sk", AttrType, AttrAuthorID, AttrKeyVersion, AttrCiphertext, AttrHasBlob,
		AttrVisibility, AttrCommentCount, AttrReactionCounts, AttrRecent, AttrReceivedAt,
		AttrUpdatedAt, AttrDeletedAt, AttrEvent, AttrSubjectID, AttrSubjectName,
	}
	names := make(map[string]string, len(fields)+1)
	paths := make([]string, 0, len(fields)+2)
	for i, field := range fields {
		placeholder := fmt.Sprintf("#f%d", i)
		names[placeholder] = field
		paths = append(paths, placeholder)
	}
	if readerID != "" {
		names["#me"] = readerID
		names["#reactors"] = AttrReactors
		names["#commenters"] = AttrCommenters
		paths = append(paths, "#reactors.#me", "#commenters.#me")
	}
	return aws.String(strings.Join(paths, ", ")), names
}
