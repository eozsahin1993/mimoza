package posts

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

// The slice's service depends on the interface, not this type; the
// assertion is what makes a drift between them a build failure here
// rather than a wiring failure in internal/app.
var _ store = (*Store)(nil)

// PutPost writes one post and moves the circle's lastEntryAt. The post
// is conditional on its own id, so a client that retries gets the entry
// it already wrote rather than a second copy of it.
func (s *Store) PutPost(ctx context.Context, circleID string, entry circles.Entry) (circles.Entry, error) {
	entry.ReceivedAt = s.Now()
	err := dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Put: &types.Put{
					TableName:           aws.String(s.Name),
					Item:                dynamo.PostItem(circleID, entry),
					ConditionExpression: aws.String("attribute_not_exists(sk)"),
				}},
				{Update: s.TouchCircle(circleID, entry.ReceivedAt)},
			},
		})
		return err
	})
	if dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed {
		return s.GetPost(ctx, circleID, entry.ID, "")
	}
	if err != nil {
		return circles.Entry{}, err
	}
	return s.GetPost(ctx, circleID, entry.ID, "")
}

func (s *Store) SetVisibility(ctx context.Context, circleID, postID, visibility string) (circles.Entry, error) {
	now := s.Now()
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.Name),
		Key:       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(postID)),
		UpdateExpression: aws.String("SET " + dynamo.AttrVisibility + " = :visibility, " + dynamo.AttrUpdatedAt + " = :now, " +
			dynamo.ByTypeUpdatedKey + " = :key"),
		ConditionExpression: aws.String("attribute_exists(sk) AND attribute_not_exists(" + dynamo.AttrDeletedAt + ")"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":visibility": dynamoutil.Str(visibility),
			":now":        dynamoutil.Millis(now),
			":key":        dynamoutil.Str(circles.IndexKey(circles.TypePost, now, postID)),
		},
	})
	if dynamoutil.ConditionFailed(err) {
		return circles.Entry{}, circles.ErrEntryNotFound
	}
	if err != nil {
		return circles.Entry{}, err
	}
	return s.GetPost(ctx, circleID, postID, "")
}

// DeletePost strips the ciphertext and stamps deletedAt, keeping the row
// and both index keys so the deletion itself reaches every device
// through the same walk everything else does.
func (s *Store) DeletePost(ctx context.Context, circleID, postID string) (circles.Entry, error) {
	now := s.Now()
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.Name),
		Key:       s.Key(dynamo.CirclePK(circleID), dynamo.EntryKey(postID)),
		UpdateExpression: aws.String("SET " + dynamo.AttrDeletedAt + " = :now, " + dynamo.AttrUpdatedAt + " = :now, " +
			dynamo.ByTypeUpdatedKey + " = :key REMOVE " + dynamo.AttrCiphertext),
		// Not already deleted: without this a repeat restamps deletedAt
		// and the forward index key, which pushes a post nobody can read
		// back to the head of every device's walk.
		ConditionExpression: aws.String("attribute_exists(sk) AND attribute_not_exists(" + dynamo.AttrDeletedAt + ")"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":now": dynamoutil.Millis(now),
			":key": dynamoutil.Str(circles.IndexKey(circles.TypePost, now, postID)),
		},
	})
	if dynamoutil.ConditionFailed(err) {
		// Either it was never there, or it is already gone — and a
		// repeated deletion is the outcome the caller asked for.
		return s.GetPost(ctx, circleID, postID, "")
	}
	if err != nil {
		return circles.Entry{}, err
	}
	return s.GetPost(ctx, circleID, postID, "")
}

// Entries is one page of a walk: the next rows after the cursor's
// position, in the index that cursor belongs to.
func (s *Store) ListEntries(ctx context.Context, circleID, readerID string, cursor circles.Cursor, limit int32) (circles.Page, error) {
	index, partition, key := dynamo.ByTypeReceivedIndex, dynamo.ByTypeReceivedPK, dynamo.ByTypeReceivedKey
	forward := cursor.Direction == circles.Forward
	if cursor.Type == circles.TypePost && forward {
		index, partition, key = dynamo.ByTypeUpdatedIndex, dynamo.ByTypeUpdatedPK, dynamo.ByTypeUpdatedKey
	}

	condition := partition + " = :pk AND " + key + " < :position"
	if forward {
		condition = partition + " = :pk AND " + key + " > :position"
	}
	position := cursor.Position()
	if cursor.IsZero() {
		// No cursor: the newest page, read backward from the end of this
		// type's own partition.
		forward = false
		condition = partition + " = :pk"
	}

	projection, names := dynamo.ProjectionFor(readerID)
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Name),
		IndexName:                 aws.String(index),
		KeyConditionExpression:    aws.String(condition),
		ExpressionAttributeValues: values(dynamo.TypePartition(circleID, cursor.Type), position, cursor.IsZero()),
		ProjectionExpression:      projection,
		ExpressionAttributeNames:  names,
		ScanIndexForward:          aws.Bool(forward),
		Limit:                     aws.Int32(limit),
	})
	if err != nil {
		return circles.Page{}, err
	}

	entries := make([]circles.Entry, 0, len(out.Items))
	for _, item := range out.Items {
		entries = append(entries, dynamo.EntryFrom(item))
	}
	if !forward {
		// A backward read comes back newest first; a page always hands
		// back oldest first, so a client applies in one direction only.
		for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
			entries[i], entries[j] = entries[j], entries[i]
		}
	}

	page := circles.Page{Entries: entries, More: len(entries) == int(limit)}
	if len(entries) > 0 {
		// Each cursor resumes in its own index, so each takes the entry
		// that is last in that index — not the last row of this page,
		// which is only ordered by the index this read happened to use.
		page.Next = circles.Cursor{Type: cursor.Type, Direction: circles.Forward}.
			Advance(furthestForward(entries, cursor.Type), page.More && forward)
		page.Prev = circles.Cursor{Type: cursor.Type, Direction: circles.Backward}.
			Advance(earliestReceived(entries), page.More && !forward)
	}
	return page, nil
}

// furthestForward is the entry a forward walk should resume after: the
// greatest updatedAt for posts, the greatest receivedAt for activity.
func furthestForward(entries []circles.Entry, entryType string) circles.Entry {
	furthest := entries[0]
	for _, entry := range entries[1:] {
		if entryType == circles.TypePost {
			if entry.UpdatedAt.After(furthest.UpdatedAt) {
				furthest = entry
			}
			continue
		}
		if entry.ReceivedAt.After(furthest.ReceivedAt) {
			furthest = entry
		}
	}
	return furthest
}

// earliestReceived is where paging further back continues from.
func earliestReceived(entries []circles.Entry) circles.Entry {
	earliest := entries[0]
	for _, entry := range entries[1:] {
		if entry.ReceivedAt.Before(earliest.ReceivedAt) {
			earliest = entry
		}
	}
	return earliest
}

// CountEntries is the completeness check a device runs against its own
// count. Read through the index the walk uses, so a row that has not
// propagated is missing from both and raises no false alarm.
func (s *Store) CountEntries(ctx context.Context, circleID, entryType string) (int64, error) {
	var total int64
	var start map[string]types.AttributeValue
	for {
		out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.Name),
			IndexName:              aws.String(dynamo.ByTypeReceivedIndex),
			KeyConditionExpression: aws.String(dynamo.ByTypeReceivedPK + " = :pk"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk": dynamoutil.Str(dynamo.TypePartition(circleID, entryType)),
			},
			Select:            types.SelectCount,
			ExclusiveStartKey: start,
		})
		if err != nil {
			return 0, err
		}
		total += int64(out.Count)
		if len(out.LastEvaluatedKey) == 0 {
			return total, nil
		}
		start = out.LastEvaluatedKey
	}
}

// values is the query's bindings: a first read has no position, and
// binding one DynamoDB never sees is rejected.
func values(partition, position string, atStart bool) map[string]types.AttributeValue {
	if atStart {
		return map[string]types.AttributeValue{":pk": dynamoutil.Str(partition)}
	}
	return map[string]types.AttributeValue{
		":pk":       dynamoutil.Str(partition),
		":position": dynamoutil.Str(position),
	}
}
