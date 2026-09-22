package reactions

import (
	"context"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/util/dynamoutil"
)

// Store is this slice's own reads and writes against the circles table.
// It embeds the shared table for the key shapes, the item encoding and
// the handful of reads more than one slice needs.
type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

// React sets this member's reaction, adjusting the post's per-tag counts
// by the difference. A reaction is a slot rather than an event, so
// changing one cannot double-count and a retry is harmless.
func (s *Store) SetReaction(ctx context.Context, circleID string, reaction circles.Reaction) (circles.Entry, error) {
	return s.set(ctx, circleID, reaction.PostID, reaction.AccountID, &reaction)
}

// withCondition attaches a condition to whichever half of a transact
// item is set.
func withCondition(item types.TransactWriteItem, expression string, names map[string]string, values map[string]types.AttributeValue) types.TransactWriteItem {
	switch {
	case item.Put != nil:
		item.Put.ConditionExpression = aws.String(expression)
		item.Put.ExpressionAttributeNames = names
		item.Put.ExpressionAttributeValues = values
	case item.Delete != nil:
		item.Delete.ConditionExpression = aws.String(expression)
		item.Delete.ExpressionAttributeNames = names
		item.Delete.ExpressionAttributeValues = values
	}
	return item
}

func (s *Store) ClearReaction(ctx context.Context, circleID, postID, accountID string) (circles.Entry, error) {
	return s.set(ctx, circleID, postID, accountID, nil)
}
func (s *Store) set(ctx context.Context, circleID, postID, accountID string, next *circles.Reaction) (circles.Entry, error) {
	err := dynamo.WithRetry(func() error {
		previous, err := s.GetReaction(ctx, circleID, postID, accountID)
		if err != nil {
			return err
		}
		if next != nil && previous != nil && previous.Tag == next.Tag {
			return nil // The same reaction again.
		}
		if next == nil && previous == nil {
			return nil // Nothing to take back.
		}

		now := s.Now()
		counts := []string{}
		names := map[string]string{"#reactor": accountID}
		values := map[string]types.AttributeValue{
			":now": dynamo.Millis(now),
			":key": dynamo.Str(circles.IndexKey(circles.TypePost, now, postID)),
		}
		if previous != nil {
			counts = append(counts, dynamo.AttrReactionCounts+".#old :minusOne")
			names["#old"] = previous.Tag
			values[":minusOne"] = dynamo.Num(-1)
		}
		if next != nil {
			counts = append(counts, dynamo.AttrReactionCounts+".#new :one")
			names["#new"] = next.Tag
			values[":one"] = dynamo.Num(1)
			values[":tag"] = dynamo.Str(next.Tag)
		}

		slot := types.TransactWriteItem{Delete: &types.Delete{
			TableName: aws.String(s.Name),
			Key:       s.Key(dynamo.CirclePK(circleID), dynamo.ReactionKey(postID, accountID)),
		}}
		if next != nil {
			slot = types.TransactWriteItem{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr:     dynamo.Str(dynamo.CirclePK(circleID)),
					dynamoutil.SKAttr:     dynamo.Str(dynamo.ReactionKey(postID, accountID)),
					dynamo.AttrTag:        dynamo.Str(next.Tag),
					dynamo.AttrKeyVersion: dynamo.Num(next.KeyVersion),
					dynamo.AttrCiphertext: dynamo.Binary(next.Ciphertext),
					dynamo.AttrReceivedAt: dynamo.Millis(now),
				},
			}}
		}
		// The slot is written against what was just read, so two devices
		// of the same account cannot both adjust the counts from a stale
		// view of it.
		if previous == nil {
			slot = withCondition(slot, "attribute_not_exists(sk)", nil, nil)
		} else {
			slot = withCondition(slot, dynamo.AttrTag+" = :expected", nil,
				map[string]types.AttributeValue{":expected": dynamo.Str(previous.Tag)})
		}

		_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				slot,
				{Update: &types.Update{
					TableName: aws.String(s.Name),
					Key:       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(postID)),
					UpdateExpression: aws.String("ADD " + strings.Join(counts, ", ") +
						" SET " + dynamo.AttrUpdatedAt + " = :now, " + dynamo.ByTypeUpdatedKey + " = :key" + reactorSet(next)),
					ConditionExpression:       aws.String("attribute_exists(sk) AND attribute_not_exists(" + dynamo.AttrDeletedAt + ")"),
					ExpressionAttributeNames:  names,
					ExpressionAttributeValues: values,
				}},
				{Update: s.TouchCircle(circleID, now)},
			},
		})
		return err
	})
	if dynamo.CancelledFor(err, 1) == dynamo.ConditionalCheckFailed {
		return circles.Entry{}, circles.ErrEntryNotFound
	}
	if err != nil {
		return circles.Entry{}, err
	}

	post, err := s.GetPost(ctx, circleID, postID, "")
	if err != nil {
		return circles.Entry{}, err
	}
	if next != nil {
		post.MyTag = next.Tag
	}
	return post, nil
}

// reactorSet records this member's tag on the post, or takes it off.
// Written as its own path in the same update as the counts, so the two
// can never disagree: another member's write touches a different path,
// and a repeat of this one is the same value again.
func reactorSet(next *circles.Reaction) string {
	if next == nil {
		return " REMOVE " + dynamo.AttrReactors + ".#reactor"
	}
	return ", " + dynamo.AttrReactors + ".#reactor = :tag"
}
