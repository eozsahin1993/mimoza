package requests

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

// Store is the request side of joining: the ask, and the approval that
// turns it into a membership. Approving writes the membership and its
// sealed keys itself rather than handing back to the members slice,
// because admitting someone has to be one transaction.
type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

var _ store = (*Store)(nil)

// GetInvite resolves the code a request is made against. The invites
// slice owns writing these rows; reading one here is what says which
// circle the ask belongs to.
func (s *Store) GetInvite(ctx context.Context, code string) (circles.Invite, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.Name),
		Key:            s.Key(dynamo.InvitePK(code), dynamo.MetaSK),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return circles.Invite{}, err
	}
	if out.Item == nil {
		return circles.Invite{}, circles.ErrInviteNotFound
	}

	invite := circles.Invite{
		Code:      code,
		CircleID:  dynamo.StringAt(out.Item, dynamo.AttrCircleID),
		CreatedBy: dynamo.StringAt(out.Item, dynamo.AttrCreatedBy),
		CreatedAt: dynamo.TimeAt(out.Item, dynamo.AttrCreatedAt),
		ExpiresAt: dynamo.ExpiryFrom(out.Item),
	}
	if !invite.ExpiresAt.IsZero() && invite.ExpiresAt.Before(s.Now()) {
		return circles.Invite{}, circles.ErrInviteNotFound
	}
	return invite, nil
}

// CreateRequest records someone asking to join, carrying the public key
// an approver will seal the circle's keys to. One request per account
// per circle: asking again replaces the previous ask.
func (s *Store) CreateRequest(ctx context.Context, request circles.Request) error {
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Name),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr:      dynamo.Str(dynamo.CirclePK(request.CircleID)),
			dynamoutil.SKAttr:      dynamo.Str(dynamo.RequestKey(request.ID)),
			dynamo.AttrRequesterID: dynamo.Str(request.AccountID),
			dynamo.AttrPublicKey:   dynamo.Binary(request.PublicKey),
			dynamo.AttrStatus:      dynamo.Str(request.Status),
			dynamo.AttrCreatedAt:   dynamo.Millis(request.CreatedAt),
			dynamo.AttrExpiresAt:   dynamo.Num(request.ExpiresAt.Unix()),
		},
	})
	return err
}

func (s *Store) ListRequests(ctx context.Context, circleID string) ([]circles.Request, error) {
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:              aws.String(s.Name),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     dynamo.Str(dynamo.CirclePK(circleID)),
			":prefix": dynamo.Str(dynamo.RequestSK),
		},
	})

	var requests []circles.Request
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			requests = append(requests, circles.Request{
				ID:        strings.TrimPrefix(dynamo.StringAt(item, dynamoutil.SKAttr), dynamo.RequestSK),
				CircleID:  circleID,
				AccountID: dynamo.StringAt(item, dynamo.AttrRequesterID),
				PublicKey: dynamo.BytesAt(item, dynamo.AttrPublicKey),
				Status:    dynamo.StringAt(item, dynamo.AttrStatus),
				CreatedAt: dynamo.TimeAt(item, dynamo.AttrCreatedAt),
				ExpiresAt: dynamo.ExpiryFrom(item),
			})
		}
	}
	return requests, nil
}

// Approve admits the requester: the membership, every content key sealed
// to them, the request's new status and the activity row, in one
// transaction. Anything less could leave a member who cannot read, or a
// request that looks pending after it was granted.
func (s *Store) ApproveRequest(ctx context.Context, circleID, requestID, actorID string, member circles.Member, sealed circles.SealedKeys, name string) error {
	circle, err := s.GetCircle(ctx, circleID)
	if err != nil {
		return err
	}
	// Every version, or the joiner cannot read the history they were
	// admitted to see.
	for version := int64(1); version <= circle.KeyVersion; version++ {
		if len(sealed[version]) == 0 {
			return circles.ErrIncompleteKeys
		}
	}

	roster, err := s.ListMembers(ctx, circleID)
	if err != nil {
		return err
	}
	if len(roster) >= circles.MaxMembers {
		return circles.ErrCircleFull
	}

	now := s.Now()
	_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Update: &types.Update{
				TableName:                aws.String(s.Name),
				Key:                      s.Key(dynamo.CirclePK(circleID), dynamo.RequestKey(requestID)),
				UpdateExpression:         aws.String("SET #status = :status"),
				ConditionExpression:      aws.String("attribute_exists(sk) AND #status = :pending"),
				ExpressionAttributeNames: map[string]string{"#status": dynamo.AttrStatus},
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":status":  dynamo.Str(circles.RequestApproved),
					":pending": dynamo.Str(circles.RequestPending),
				},
			}},
			{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item:      dynamo.MemberItem(circleID, member, now),
			}},
			{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr:    dynamo.Str(dynamo.CirclePK(circleID)),
					dynamoutil.SKAttr:    dynamo.Str(dynamo.SealedKeyKey(member.AccountID)),
					dynamo.AttrKeys:      dynamo.SealedKeysAttr(sealed),
					dynamo.AttrUpdatedAt: dynamo.Millis(now),
				},
			}},
			// memberCount is what makes the cap hold when two admins
			// approve at once: the count read above can be stale, this
			// condition cannot.
			{Update: &types.Update{
				TableName: aws.String(s.Name),
				Key:       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
				UpdateExpression: aws.String("ADD " + dynamo.AttrRosterVersion + " :one, " +
					dynamo.AttrMemberCount + " :one"),
				ConditionExpression: aws.String("attribute_not_exists(" + dynamo.AttrMemberCount + ") OR " +
					dynamo.AttrMemberCount + " < :cap"),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":one": dynamo.Num(1),
					":cap": dynamo.Num(circles.MaxMembers),
				},
			}},
			{Put: &types.Put{
				TableName: aws.String(s.Name),
				Item: dynamo.ActivityItem(circleID, circles.Entry{
					Type:        circles.TypeActivity,
					Event:       circles.EventJoined,
					AuthorID:    actorID,
					SubjectID:   member.AccountID,
					SubjectName: name,
					ReceivedAt:  now,
				}),
			}},
		},
	})
	switch {
	case dynamo.CancelledFor(err, 0) == dynamo.ConditionalCheckFailed:
		// Gone, or already answered — either way there is nothing to grant.
		return circles.ErrRequestNotFound
	case dynamo.CancelledFor(err, 3) == dynamo.ConditionalCheckFailed:
		return circles.ErrCircleFull
	}
	return err
}

func (s *Store) DenyRequest(ctx context.Context, circleID, requestID string) error {
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                aws.String(s.Name),
		Key:                      s.Key(dynamo.CirclePK(circleID), dynamo.RequestKey(requestID)),
		UpdateExpression:         aws.String("SET #status = :status"),
		ConditionExpression:      aws.String("attribute_exists(sk)"),
		ExpressionAttributeNames: map[string]string{"#status": dynamo.AttrStatus},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":status": dynamo.Str(circles.RequestDenied),
		},
	})
	if dynamo.ConditionFailed(err) {
		return circles.ErrRequestNotFound
	}
	return err
}
