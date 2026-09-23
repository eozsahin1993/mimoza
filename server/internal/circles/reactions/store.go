package reactions

import (
	"context"

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

// Add records one reaction. A member may hold several at once, so this
// is a row per emoji rather than a slot: reacting twice with the same
// emoji is the same row and changes nothing.
func (s *Store) Add(ctx context.Context, circleID string, reaction circles.Reaction) (circles.Entry, error) {
	return s.write(ctx, circleID, reaction.PostID, reaction.AccountID, reaction.Tag, &reaction)
}

// Remove takes one reaction back, named by its tag since "mine" no
// longer identifies a single row.
func (s *Store) Remove(ctx context.Context, circleID, postID, accountID, tag string) (circles.Entry, error) {
	return s.write(ctx, circleID, postID, accountID, tag, nil)
}

func (s *Store) write(ctx context.Context, circleID, postID, accountID, tag string, next *circles.Reaction) (circles.Entry, error) {
	err := dynamo.WithRetry(func() error {
		held, err := s.ReactionsBy(ctx, circleID, postID, accountID)
		if err != nil {
			return err
		}
		has := false
		for _, reaction := range held {
			if reaction.Tag == tag {
				has = true
			}
		}
		if (next != nil) == has {
			return nil // Already reacted with this, or nothing to take back.
		}

		now := s.Now()
		// Only the names the expression actually uses: DynamoDB rejects
		// an unused one outright.
		names := map[string]string{"#tag": tag}
		values := map[string]types.AttributeValue{
			":now":   dynamoutil.Millis(now),
			":key":   dynamoutil.Str(circles.IndexKey(circles.TypePost, now, postID)),
			":delta": dynamoutil.Num(1),
		}

		var row types.TransactWriteItem
		reactors := ", " + dynamo.AttrReactors + ".#reactor = :reacted"
		if next == nil {
			values[":delta"] = dynamoutil.Num(-1)
			row = types.TransactWriteItem{Delete: &types.Delete{
				TableName:           aws.String(s.Name),
				Key:                 s.Key(dynamo.CirclePK(circleID), dynamo.ReactionKey(postID, accountID, tag)),
				ConditionExpression: aws.String("attribute_exists(sk)"),
			}}
			// The flag says "has reacted at all", so it only comes off
			// with the last one. Another device of theirs adding one in
			// between would leave it off; their next reaction sets it
			// again, and nothing but a filled icon depends on it.
			reactors = ""
			if len(held) == 1 {
				reactors = " REMOVE " + dynamo.AttrReactors + ".#reactor"
				names["#reactor"] = accountID
			}
		} else {
			names["#reactor"] = accountID
			values[":reacted"] = dynamoutil.Bool(true)
			row = types.TransactWriteItem{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr:     dynamoutil.Str(dynamo.CirclePK(circleID)),
					dynamoutil.SKAttr:     dynamoutil.Str(dynamo.ReactionKey(postID, accountID, tag)),
					dynamo.AttrTag:        dynamoutil.Str(tag),
					dynamo.AttrKeyVersion: dynamoutil.Num(next.KeyVersion),
					dynamo.AttrCiphertext: dynamoutil.Binary(next.Ciphertext),
					dynamo.AttrReceivedAt: dynamoutil.Millis(now),
				},
				ConditionExpression: aws.String("attribute_not_exists(sk)"),
			}}
		}

		_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				row,
				{Update: &types.Update{
					TableName: aws.String(s.Name),
					Key:       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(postID)),
					UpdateExpression: aws.String("ADD " + dynamo.AttrReactionCounts + ".#tag :delta" +
						" SET " + dynamo.AttrUpdatedAt + " = :now, " + dynamo.ByTypeUpdatedKey + " = :key" + reactors),
					ConditionExpression:       aws.String("attribute_exists(sk) AND attribute_not_exists(" + dynamo.AttrDeletedAt + ")"),
					ExpressionAttributeNames:  names,
					ExpressionAttributeValues: values,
				}},
				{Update: s.TouchCircle(circleID, now)},
			},
		})
		return err
	})
	switch {
	case dynamoutil.CancelledFor(err, 1) == dynamoutil.ConditionalCheckFailed:
		return circles.Entry{}, circles.ErrEntryNotFound
	case dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed:
		// Another device of theirs got there first; the outcome is the
		// one the caller asked for either way.
	case err != nil:
		return circles.Entry{}, err
	}

	return s.GetPost(ctx, circleID, postID, accountID)
}
