package circle

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/circles/members"
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
// rather than a wiring failure in internal/api.
var _ store = (*Store)(nil)

// ListMemberships is GET /circles: every circle this account belongs to.
// It lives here as well as in the members slice because the two answer
// different questions — "which circles am I in" is about the collection,
// "who is in this circle" is about one of them.
func (s *Store) ListMemberships(ctx context.Context, accountID string) ([]circles.Membership, error) {
	return members.NewStore(s.Table).ListMemberships(ctx, accountID)
}

// Create writes a circle, its founding admin, that admin's copy of the
// first content key and the activity row recording it — one transaction,
// so a circle can never exist without someone able to read it.
func (s *Store) CreateCircle(ctx context.Context, circle circles.Circle, founder circles.Member, sealed []byte) error {
	now := s.Now()
	activity := circles.Entry{
		Type:        circles.TypeActivity,
		Event:       circles.EventCreated,
		AuthorID:    founder.AccountID,
		SubjectID:   founder.AccountID,
		SubjectName: circle.Name,
		ReceivedAt:  now,
	}

	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr:        dynamo.Str(dynamo.CirclePK(circle.ID)),
					dynamoutil.SKAttr:        dynamo.Str(dynamo.MetaSK),
					dynamo.AttrName:          dynamo.Str(circle.Name),
					dynamo.AttrKeyVersion:    dynamo.Num(1),
					dynamo.AttrRosterVersion: dynamo.Num(1),
					dynamo.AttrMemberCount:   dynamo.Num(1),
					dynamo.AttrAdminCount:    dynamo.Num(1),
					dynamo.AttrLastEntryAt:   dynamo.Millis(now),
					dynamo.AttrCreatedBy:     dynamo.Str(founder.AccountID),
					dynamo.AttrCreatedAt:     dynamo.Millis(now),
				},
				ConditionExpression: aws.String("attribute_not_exists(pk)"),
			}},
			{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item:      dynamo.MemberItem(circle.ID, founder, now),
			}},
			{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr:    dynamo.Str(dynamo.CirclePK(circle.ID)),
					dynamoutil.SKAttr:    dynamo.Str(dynamo.SealedKeyKey(founder.AccountID)),
					dynamo.AttrKeys:      dynamo.SealedKeysAttr(circles.SealedKeys{1: sealed}),
					dynamo.AttrUpdatedAt: dynamo.Millis(now),
				},
			}},
			{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item:      dynamo.ActivityItem(circle.ID, activity),
			}},
		},
	})
	if dynamo.CancelledFor(err, 0) == dynamo.ConditionalCheckFailed {
		return circles.ErrAlreadyExists
	}
	return err
}

// Update sets the name, the cover, or both, and records whichever
// changed. Empty means "leave it alone", so a cover change does not have
// to resend the name.
func (s *Store) UpdateCircle(ctx context.Context, circleID, name, coverID, actorID string) (circles.Circle, error) {
	if name == "" && coverID == "" {
		return s.GetCircle(ctx, circleID)
	}

	sets := []string{}
	values := map[string]types.AttributeValue{}
	if name != "" {
		sets = append(sets, dynamo.AttrName+" = :name")
		values[":name"] = dynamo.Str(name)
	}
	if coverID != "" {
		sets = append(sets, dynamo.AttrCoverID+" = :cover")
		values[":cover"] = dynamo.Str(coverID)
	}

	update := "SET " + sets[0]
	for _, set := range sets[1:] {
		update += ", " + set
	}

	now := s.Now()
	items := []types.TransactWriteItem{
		{Update: &types.Update{
			TableName:                 aws.String(s.Name),
			Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
			UpdateExpression:          aws.String(update),
			ConditionExpression:       aws.String("attribute_exists(pk)"),
			ExpressionAttributeValues: values,
		}},
		{Update: s.TouchCircle(circleID, now)},
	}
	// One request can change both, and the wall shows them as two
	// different things, so each gets its own row.
	if name != "" {
		items = append(items, activity(s, circleID, actorID, circles.EventRenamed, name, now))
	}
	if coverID != "" {
		items = append(items, activity(s, circleID, actorID, circles.EventCoverChanged, coverID, now))
	}

	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
	if dynamo.CancelledFor(err, 0) == dynamo.ConditionalCheckFailed {
		return circles.Circle{}, circles.ErrCircleNotFound
	}
	if err != nil {
		return circles.Circle{}, err
	}
	return s.GetCircle(ctx, circleID)
}

// Delete removes a whole circle: every row in its partition, plus the
// lookup rows its invite codes own. Blobs are the caller's to sweep —
// they live in S3, not here.
func (s *Store) DeleteCircle(ctx context.Context, circleID string) error {
	codes, err := s.inviteCodes(ctx, circleID)
	if err != nil {
		return err
	}

	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Name),
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": dynamo.Str(dynamo.CirclePK(circleID))},
		ProjectionExpression:      aws.String("pk, sk"),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return err
		}
		if err := s.deleteKeys(ctx, page.Items); err != nil {
			return err
		}
	}

	lookups := make([]map[string]types.AttributeValue, 0, len(codes))
	for _, code := range codes {
		lookups = append(lookups, s.Key(dynamo.InvitePK(code), dynamo.MetaSK))
	}
	return s.deleteKeys(ctx, lookups)
}

// deleteKeys removes rows in batches of 25, DynamoDB's limit for one
// BatchWriteItem.
func (s *Store) deleteKeys(ctx context.Context, keys []map[string]types.AttributeValue) error {
	const batch = 25
	for start := 0; start < len(keys); start += batch {
		end := min(start+batch, len(keys))

		requests := make([]types.WriteRequest, 0, end-start)
		for _, key := range keys[start:end] {
			requests = append(requests, types.WriteRequest{
				DeleteRequest: &types.DeleteRequest{Key: key},
			})
		}

		unprocessed := map[string][]types.WriteRequest{s.Name: requests}
		for attempt := range dynamo.MaxAttempts {
			out, err := s.Client.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{RequestItems: unprocessed})
			if err != nil {
				return err
			}
			if len(out.UnprocessedItems[s.Name]) == 0 {
				break
			}
			unprocessed = out.UnprocessedItems
			if attempt == dynamo.MaxAttempts-1 {
				return fmt.Errorf("circles: %d rows would not delete", len(unprocessed[s.Name]))
			}
		}
	}
	return nil
}

// inviteCodes lists the codes this circle handed out, which own lookup
// rows in their own partitions — the only rows a circle owns outside its
// own partition, and so the only ones its deletion has to chase.
func (s *Store) inviteCodes(ctx context.Context, circleID string) ([]string, error) {
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:              aws.String(s.Name),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     dynamo.Str(dynamo.CirclePK(circleID)),
			":prefix": dynamo.Str(dynamo.InviteSK),
		},
		ProjectionExpression: aws.String("sk"),
	})

	var codes []string
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			codes = append(codes, strings.TrimPrefix(dynamo.StringAt(item, dynamoutil.SKAttr), dynamo.InviteSK))
		}
	}
	return codes, nil
}

// activity is the row a circle change records. subject carries the new
// name or the new cover id, so a device can render the line without
// reading the circle back.
func activity(s *Store, circleID, actorID, event, subject string, at time.Time) types.TransactWriteItem {
	return types.TransactWriteItem{Put: &types.Put{
		TableName: aws.String(s.Name),
		Item: dynamo.ActivityItem(circleID, circles.Entry{
			Type:        circles.TypeActivity,
			Event:       event,
			AuthorID:    actorID,
			SubjectName: subject,
			ReceivedAt:  at,
		}),
	}}
}
