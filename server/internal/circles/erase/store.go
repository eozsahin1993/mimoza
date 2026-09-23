// Package erase removes one account from every circle it was in. It
// answers no route: deleting an account is one act that reaches the
// whole column rather than owning a resource within it.
package erase

import (
	"context"
	"errors"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/util/dynamoutil"
)

var errUnfinished = errors.New("circles: a batch of deletes stalled")

type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

// Erased is what the caller still has to delete from the bucket.
type Erased struct {
	BlobKeys []string
	Prefixes []string
}

// Account removes the account from every circle. There is no
// transaction around the whole thing, so it is idempotent and ordered:
// content is stripped before the membership goes, or an interrupted run
// would leave content with no membership to find it by.
func (s *Store) Account(ctx context.Context, accountID, name string) (Erased, error) {
	circleIDs, err := s.circlesOf(ctx, accountID)
	if err != nil {
		return Erased{}, err
	}

	var erased Erased
	for _, circleID := range circleIDs {
		keys, err := s.stripContent(ctx, circleID, accountID)
		if err != nil {
			return erased, err
		}
		erased.BlobKeys = append(erased.BlobKeys, keys...)

		roster, err := s.ListMembers(ctx, circleID)
		if err != nil {
			return erased, err
		}
		// The last member out takes the circle: nobody could read it.
		if len(roster) <= 1 {
			if err := s.deleteCircle(ctx, circleID); err != nil {
				return erased, err
			}
			erased.Prefixes = append(erased.Prefixes, circleID+"/")
			continue
		}
		if err := s.leave(ctx, circleID, accountID, name, roster); err != nil {
			return erased, err
		}
	}
	return erased, s.forgetRequests(ctx, accountID)
}

func (s *Store) circlesOf(ctx context.Context, accountID string) ([]string, error) {
	return s.byAccount(ctx, accountID, dynamo.MemberSK)
}

func (s *Store) byAccount(ctx context.Context, accountID, prefix string) ([]string, error) {
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:              aws.String(s.Name),
		IndexName:              aws.String(dynamo.ByAccountIndex),
		KeyConditionExpression: aws.String(dynamo.ByAccountPK + " = :account AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":account": dynamoutil.Str(accountID),
			":prefix":  dynamoutil.Str(prefix),
		},
	})

	var circleIDs []string
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			pk := dynamoutil.StringAt(item, dynamoutil.PKAttr)
			circleIDs = append(circleIDs, strings.TrimPrefix(pk, dynamo.CirclePKPrefix))
		}
	}
	return circleIDs, nil
}

// stripContent empties what this account wrote in one circle. The rows
// stay, stamped deleted, so a walk delivers the deletion rather than
// finding a hole where a cursor pointed.
func (s *Store) stripContent(ctx context.Context, circleID, accountID string) ([]string, error) {
	items, err := s.partition(ctx, circleID)
	if err != nil {
		return nil, err
	}

	var blobKeys []string
	for _, item := range items {
		sk := dynamoutil.StringAt(item, dynamoutil.SKAttr)
		switch {
		case strings.HasPrefix(sk, dynamo.EntrySK):
			if dynamoutil.StringAt(item, dynamo.AttrAuthorID) != accountID {
				continue
			}
			// Activity rows are the relay's own and stay.
			if dynamoutil.StringAt(item, dynamo.AttrType) != circles.TypePost {
				continue
			}
			postID := strings.TrimPrefix(sk, dynamo.EntrySK)
			if !dynamoutil.TimeAt(item, dynamo.AttrDeletedAt).IsZero() {
				continue
			}
			if err := s.stripPost(ctx, circleID, postID); err != nil {
				return blobKeys, err
			}
			if dynamoutil.BoolAt(item, dynamo.AttrHasBlob) {
				blobKeys = append(blobKeys, circleID+"/"+postID)
			}

		case strings.Contains(sk, dynamo.CommentSeg):
			if dynamoutil.StringAt(item, dynamo.AttrAuthorID) != accountID {
				continue
			}
			if !dynamoutil.TimeAt(item, dynamo.AttrDeletedAt).IsZero() {
				continue
			}
			postID := strings.TrimPrefix(sk[:strings.Index(sk, dynamo.CommentSeg)], dynamo.ChildSK)
			if err := s.stripComment(ctx, circleID, postID, sk, accountID); err != nil {
				return blobKeys, err
			}

		case strings.Contains(sk, dynamo.ReactSeg):
			// One row per emoji, so a member can appear several times on
			// the same post.
			owner, tag, _ := strings.Cut(sk[strings.Index(sk, dynamo.ReactSeg)+len(dynamo.ReactSeg):], "#")
			if owner != accountID {
				continue
			}
			postID := strings.TrimPrefix(sk[:strings.Index(sk, dynamo.ReactSeg)], dynamo.ChildSK)
			if err := s.dropReaction(ctx, circleID, postID, accountID, tag); err != nil {
				return blobKeys, err
			}
		}
	}
	return blobKeys, nil
}

// stripPost takes the same shape as an ordinary delete.
func (s *Store) stripPost(ctx context.Context, circleID, postID string) error {
	now := s.Now()
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.Name),
		Key:       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(postID)),
		UpdateExpression: aws.String("SET " + dynamo.AttrDeletedAt + " = :now, " + dynamo.AttrUpdatedAt + " = :now, " +
			dynamo.ByTypeUpdatedKey + " = :key REMOVE " + dynamo.AttrCiphertext),
		ConditionExpression: aws.String("attribute_exists(sk) AND attribute_not_exists(" + dynamo.AttrDeletedAt + ")"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":now": dynamoutil.Millis(now),
			":key": dynamoutil.Str(circles.IndexKey(circles.TypePost, now, postID)),
		},
	})
	if dynamoutil.ConditionFailed(err) {
		return nil
	}
	return err
}

// stripComment takes the count with it. The parent may be gone.
func (s *Store) stripComment(ctx context.Context, circleID, postID, childKey, accountID string) error {
	now := s.Now()
	err := dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Update: &types.Update{
					TableName:        aws.String(s.Name),
					Key:              s.Key(dynamo.CirclePK(circleID), childKey),
					UpdateExpression: aws.String("SET " + dynamo.AttrDeletedAt + " = :now REMOVE " + dynamo.AttrCiphertext),
					ConditionExpression: aws.String("attribute_exists(sk) AND attribute_not_exists(" +
						dynamo.AttrDeletedAt + ")"),
					ExpressionAttributeValues: map[string]types.AttributeValue{":now": dynamoutil.Millis(now)},
				}},
				{Update: &types.Update{
					TableName: aws.String(s.Name),
					Key:       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(postID)),
					UpdateExpression: aws.String("ADD " + dynamo.AttrCommentCount + " :minusOne SET " +
						dynamo.AttrUpdatedAt + " = :now, " + dynamo.ByTypeUpdatedKey + " = :key REMOVE " +
						dynamo.AttrCommenters + ".#who"),
					ConditionExpression:      aws.String("attribute_exists(sk)"),
					ExpressionAttributeNames: map[string]string{"#who": accountID},
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":minusOne": dynamoutil.Num(-1),
						":now":      dynamoutil.Millis(now),
						":key":      dynamoutil.Str(circles.IndexKey(circles.TypePost, now, postID)),
					},
				}},
			},
		})
		return err
	})
	if dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed ||
		dynamoutil.CancelledFor(err, 1) == dynamoutil.ConditionalCheckFailed {
		return nil
	}
	return err
}

// dropReaction removes one reaction row and its count.
func (s *Store) dropReaction(ctx context.Context, circleID, postID, accountID, tag string) error {
	now := s.Now()
	err := dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Delete: &types.Delete{
					TableName:           aws.String(s.Name),
					Key:                 s.Key(dynamo.CirclePK(circleID), dynamo.ReactionKey(postID, accountID, tag)),
					ConditionExpression: aws.String("attribute_exists(sk)"),
				}},
				{Update: &types.Update{
					TableName: aws.String(s.Name),
					Key:       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(postID)),
					UpdateExpression: aws.String("ADD " + dynamo.AttrReactionCounts + ".#tag :minusOne SET " +
						dynamo.AttrUpdatedAt + " = :now, " + dynamo.ByTypeUpdatedKey + " = :key REMOVE " +
						dynamo.AttrReactors + ".#who"),
					ConditionExpression:      aws.String("attribute_exists(sk)"),
					ExpressionAttributeNames: map[string]string{"#tag": tag, "#who": accountID},
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":minusOne": dynamoutil.Num(-1),
						":now":      dynamoutil.Millis(now),
						":key":      dynamoutil.Str(circles.IndexKey(circles.TypePost, now, postID)),
					},
				}},
			},
		})
		return err
	})
	if dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed ||
		dynamoutil.CancelledFor(err, 1) == dynamoutil.ConditionalCheckFailed {
		return nil
	}
	return err
}

func (s *Store) partition(ctx context.Context, circleID string) ([]map[string]types.AttributeValue, error) {
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:              aws.String(s.Name),
		KeyConditionExpression: aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk": dynamoutil.Str(dynamo.CirclePK(circleID)),
		},
	})

	var items []map[string]types.AttributeValue
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
	}
	return items, nil
}

// leave takes the account out of a circle that has other members. The
// name is stamped now, since the profile is about to be gone.
func (s *Store) leave(ctx context.Context, circleID, accountID, name string, roster []circles.Member) error {
	var self circles.Member
	admins := 0
	for _, member := range roster {
		if member.AccountID == accountID {
			self = member
		}
		if member.IsAdmin() {
			admins++
		}
	}
	if self.AccountID == "" {
		return nil
	}

	now := s.Now()
	meta := "SET " + dynamo.AttrLastEntryAt + " = :now ADD " + dynamo.AttrRosterVersion + " :one, " +
		dynamo.AttrMemberCount + " :minusOne"
	values := map[string]types.AttributeValue{
		":one": dynamoutil.Num(1), ":minusOne": dynamoutil.Num(-1), ":now": dynamoutil.Millis(now),
	}
	items := []types.TransactWriteItem{
		{Delete: &types.Delete{
			TableName:           aws.String(s.Name),
			Key:                 s.Key(dynamo.CirclePK(circleID), dynamo.MemberKey(accountID)),
			ConditionExpression: aws.String("attribute_exists(sk)"),
		}},
		{Delete: &types.Delete{
			TableName: aws.String(s.Name),
			Key:       s.Key(dynamo.CirclePK(circleID), dynamo.SealedKeyKey(accountID)),
		}},
		{Put: &types.Put{
			TableName: aws.String(s.Name),
			Item: dynamo.ActivityItem(circleID, circles.Entry{
				Type:        circles.TypeActivity,
				Event:       circles.EventAccountDeleted,
				AuthorID:    accountID,
				SubjectID:   accountID,
				SubjectName: name,
				ReceivedAt:  now,
			}),
		}},
	}

	if self.IsAdmin() {
		successor := circles.Member{}
		if admins == 1 {
			successor = longestStanding(roster, accountID)
		}
		if successor.AccountID == "" {
			meta += ", " + dynamo.AttrAdminCount + " :minusOne"
		} else {
			// adminCount does not move, and naming it twice in one
			// expression is rejected outright.
			items = append(items,
				types.TransactWriteItem{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MemberKey(successor.AccountID)),
					UpdateExpression:          aws.String("SET #role = :admin"),
					ConditionExpression:       aws.String("attribute_exists(sk)"),
					ExpressionAttributeNames:  map[string]string{"#role": dynamo.AttrRole},
					ExpressionAttributeValues: map[string]types.AttributeValue{":admin": dynamoutil.Str(circles.RoleAdmin)},
				}},
				types.TransactWriteItem{Put: &types.Put{
					TableName: aws.String(s.Name),
					Item: dynamo.ActivityItem(circleID, circles.Entry{
						Type:       circles.TypeActivity,
						Event:      circles.EventPromoted,
						AuthorID:   accountID,
						SubjectID:  successor.AccountID,
						ReceivedAt: now,
					}),
				}})
		}
	}

	items = append(items, types.TransactWriteItem{Update: &types.Update{
		TableName:                 aws.String(s.Name),
		Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
		UpdateExpression:          aws.String(meta),
		ExpressionAttributeValues: values,
	}})

	err := dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
		return err
	})
	if dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed {
		return nil // already gone: a retry of a run that got this far
	}
	return err
}

// longestStanding inherits the circle: nobody is left who could choose.
func longestStanding(roster []circles.Member, exclude string) circles.Member {
	var successor circles.Member
	for _, member := range roster {
		if member.AccountID == exclude {
			continue
		}
		if successor.AccountID == "" || member.JoinedAt.Before(successor.JoinedAt) {
			successor = member
		}
	}
	return successor
}

// deleteCircle removes the partition and the lookup each invite owns.
func (s *Store) deleteCircle(ctx context.Context, circleID string) error {
	items, err := s.partition(ctx, circleID)
	if err != nil {
		return err
	}

	keys := make([]map[string]types.AttributeValue, 0, len(items))
	for _, item := range items {
		sk := dynamoutil.StringAt(item, dynamoutil.SKAttr)
		keys = append(keys, s.Key(dynamo.CirclePK(circleID), sk))
		if code, found := strings.CutPrefix(sk, dynamo.InviteSK); found {
			keys = append(keys, s.Key(dynamo.InvitePK(code), dynamo.MetaSK))
		}
	}
	return s.deleteKeys(ctx, keys)
}

// forgetRequests drops asks to circles it never got into: they carry a
// public key nobody will seal to now.
func (s *Store) forgetRequests(ctx context.Context, accountID string) error {
	circleIDs, err := s.byAccount(ctx, accountID, dynamo.RequestSK)
	if err != nil {
		return err
	}

	keys := make([]map[string]types.AttributeValue, 0, len(circleIDs))
	for _, circleID := range circleIDs {
		keys = append(keys, s.Key(dynamo.CirclePK(circleID), dynamo.RequestKey(circles.RequestID(accountID))))
	}
	return s.deleteKeys(ctx, keys)
}

// deleteKeys removes rows in batches of 25, DynamoDB's limit for one
// BatchWriteItem.
func (s *Store) deleteKeys(ctx context.Context, keys []map[string]types.AttributeValue) error {
	const batch = 25
	for start := 0; start < len(keys); start += batch {
		end := min(start+batch, len(keys))

		requests := make([]types.WriteRequest, 0, end-start)
		for _, key := range keys[start:end] {
			requests = append(requests, types.WriteRequest{DeleteRequest: &types.DeleteRequest{Key: key}})
		}
		for len(requests) > 0 {
			out, err := s.Client.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
				RequestItems: map[string][]types.WriteRequest{s.Name: requests},
			})
			if err != nil {
				return err
			}
			// Throttling comes back as writes left undone, not an error.
			left := out.UnprocessedItems[s.Name]
			if len(left) >= len(requests) {
				return errUnfinished
			}
			requests = left
		}
	}
	return nil
}
