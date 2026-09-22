package comments

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

// Comment writes the comment and moves its post: the count, the preview
// the wall renders, and the post's position in the forward walk, so a
// device that had already passed that post is handed it again.
func (s *Store) AddComment(ctx context.Context, circleID string, comment circles.Comment) (circles.Entry, error) {
	comment.ReceivedAt = s.Now()
	item := map[string]types.AttributeValue{
		dynamoutil.PKAttr:     dynamo.Str(dynamo.CirclePK(circleID)),
		dynamoutil.SKAttr:     dynamo.Str(dynamo.CommentKey(comment.PostID, comment.ID)),
		dynamo.AttrAuthorID:   dynamo.Str(comment.AuthorID),
		dynamo.AttrKeyVersion: dynamo.Num(comment.KeyVersion),
		dynamo.AttrCiphertext: dynamo.Binary(comment.Ciphertext),
		dynamo.AttrReceivedAt: dynamo.Millis(comment.ReceivedAt),
	}
	if comment.ParentCommentID != "" {
		item[dynamo.AttrParentComment] = dynamo.Str(comment.ParentCommentID)
	}

	err := dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Put: &types.Put{
					TableName:           aws.String(s.Name),
					Item:                item,
					ConditionExpression: aws.String("attribute_not_exists(sk)"),
				}},
				{Update: &types.Update{
					TableName: aws.String(s.Name),
					Key:       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(comment.PostID)),
					UpdateExpression: aws.String("ADD " + dynamo.AttrCommentCount + " :one SET " +
						dynamo.AttrUpdatedAt + " = :now, " + dynamo.ByTypeUpdatedKey + " = :key, " +
						dynamo.AttrRecent + " = :recent, " + dynamo.AttrCommenters + ".#author = :yes"),
					ExpressionAttributeNames: map[string]string{"#author": comment.AuthorID},
					ConditionExpression:      aws.String("attribute_exists(sk) AND attribute_not_exists(" + dynamo.AttrDeletedAt + ")"),
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":one":    dynamo.Num(1),
						":now":    dynamo.Millis(comment.ReceivedAt),
						":key":    dynamo.Str(circles.IndexKey(circles.TypePost, comment.ReceivedAt, comment.PostID)),
						":recent": &types.AttributeValueMemberL{Value: []types.AttributeValue{dynamo.RecentItem(comment)}},
						":yes":    dynamo.Bool(true),
					},
				}},
				{Update: s.TouchCircle(circleID, comment.ReceivedAt)},
			},
		})
		return err
	})
	switch {
	case dynamo.CancelledFor(err, 0) == dynamo.ConditionalCheckFailed:
		// The same comment id again: already written, nothing to add.
		return s.GetPost(ctx, circleID, comment.PostID, "")
	case dynamo.CancelledFor(err, 1) == dynamo.ConditionalCheckFailed:
		return circles.Entry{}, circles.ErrEntryNotFound
	case err != nil:
		return circles.Entry{}, err
	}
	return s.GetPost(ctx, circleID, comment.PostID, "")
}

// DeleteComment strips one comment and takes it off its post's count. If
// it was the one on show, the preview is rebuilt from whatever survives.
func (s *Store) DeleteComment(ctx context.Context, circleID, postID, commentID string) (circles.Entry, error) {
	post, err := s.GetPost(ctx, circleID, postID, "")
	if err != nil {
		return circles.Entry{}, err
	}

	now := s.Now()
	update := "ADD " + dynamo.AttrCommentCount + " :minusOne SET " + dynamo.AttrUpdatedAt + " = :now, " + dynamo.ByTypeUpdatedKey + " = :key"
	values := map[string]types.AttributeValue{
		":minusOne": dynamo.Num(-1),
		":now":      dynamo.Millis(now),
		":key":      dynamo.Str(circles.IndexKey(circles.TypePost, now, postID)),
	}
	if onShow(post.RecentComments, commentID) {
		survivors, err := s.newestComments(ctx, circleID, postID, commentID)
		if err != nil {
			return circles.Entry{}, err
		}
		update += ", " + dynamo.AttrRecent + " = :recent"
		values[":recent"] = &types.AttributeValueMemberL{Value: survivors}
	}

	err = dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Update: &types.Update{
					TableName: aws.String(s.Name),
					Key:       s.Key(dynamo.CirclePK(circleID), dynamo.CommentKey(postID, commentID)),
					UpdateExpression: aws.String("SET " + dynamo.AttrDeletedAt + " = :now REMOVE " +
						dynamo.AttrCiphertext),
					ConditionExpression:       aws.String("attribute_exists(sk)"),
					ExpressionAttributeValues: map[string]types.AttributeValue{":now": dynamo.Millis(now)},
				}},
				{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(postID)),
					UpdateExpression:          aws.String(update),
					ConditionExpression:       aws.String("attribute_exists(sk)"),
					ExpressionAttributeValues: values,
				}},
			},
		})
		return err
	})
	if dynamo.CancelledFor(err, 0) == dynamo.ConditionalCheckFailed {
		return circles.Entry{}, circles.ErrEntryNotFound
	}
	if err != nil {
		return circles.Entry{}, err
	}
	return s.GetPost(ctx, circleID, postID, "")
}

func onShow(preview []circles.Comment, commentID string) bool {
	for _, comment := range preview {
		if comment.ID == commentID {
			return true
		}
	}
	return false
}

// newestComments rebuilds a post's preview from the comments that are
// left, skipping the one being deleted and anything already deleted.
func (s *Store) newestComments(ctx context.Context, circleID, postID, skipID string) ([]types.AttributeValue, error) {
	comments, _, err := s.ListChildren(ctx, circleID, postID)
	if err != nil {
		return nil, err
	}

	preview := make([]types.AttributeValue, 0, dynamo.RecentComments)
	for i := len(comments) - 1; i >= 0 && len(preview) < dynamo.RecentComments; i-- {
		if comments[i].ID == skipID || !comments[i].DeletedAt.IsZero() {
			continue
		}
		preview = append(preview, dynamo.RecentItem(comments[i]))
	}
	return preview, nil
}
