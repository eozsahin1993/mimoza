package invites

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

// Store is the code side of joining: the invite rows, and the lookup
// row each code owns in its own partition so a link can be opened by
// someone who does not yet know which circle it belongs to.
type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

var _ store = (*Store)(nil)

// CreateInvite writes the invite under its circle, and a second row
// under the code itself so a link can be opened by someone who does not
// yet know which circle it belongs to.
func (s *Store) CreateInvite(ctx context.Context, invite circles.Invite) error {
	item := map[string]types.AttributeValue{
		dynamoutil.PKAttr:    dynamo.Str(dynamo.CirclePK(invite.CircleID)),
		dynamoutil.SKAttr:    dynamo.Str(dynamo.InviteKey(invite.Code)),
		dynamo.AttrCreatedBy: dynamo.Str(invite.CreatedBy),
		dynamo.AttrCreatedAt: dynamo.Millis(invite.CreatedAt),
		dynamo.AttrExpiresAt: dynamo.Num(invite.ExpiresAt.Unix()),
	}
	lookup := map[string]types.AttributeValue{
		dynamoutil.PKAttr:    dynamo.Str(dynamo.InvitePK(invite.Code)),
		dynamoutil.SKAttr:    dynamo.Str(dynamo.MetaSK),
		dynamo.AttrCircleID:  dynamo.Str(invite.CircleID),
		dynamo.AttrCreatedBy: dynamo.Str(invite.CreatedBy),
		dynamo.AttrCreatedAt: dynamo.Millis(invite.CreatedAt),
		dynamo.AttrExpiresAt: dynamo.Num(invite.ExpiresAt.Unix()),
	}

	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{TableName: aws.String(s.Name), Item: item}},
			{Put: &types.Put{
				TableName:           aws.String(s.Name),
				Item:                lookup,
				ConditionExpression: aws.String("attribute_not_exists(pk)"),
			}},
		},
	})
	if dynamo.CancelledFor(err, 1) == dynamo.ConditionalCheckFailed {
		return circles.ErrAlreadyExists
	}
	return err
}

// Invite resolves a code to the circle it opens. TTL sweeps expired rows
// eventually, so the expiry is checked here rather than trusted to it.
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

func (s *Store) ListInvites(ctx context.Context, circleID string) ([]circles.Invite, error) {
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:              aws.String(s.Name),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     dynamo.Str(dynamo.CirclePK(circleID)),
			":prefix": dynamo.Str(dynamo.InviteSK),
		},
	})

	var invites []circles.Invite
	now := s.Now()
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			invite := circles.Invite{
				Code:      strings.TrimPrefix(dynamo.StringAt(item, dynamoutil.SKAttr), dynamo.InviteSK),
				CircleID:  circleID,
				CreatedBy: dynamo.StringAt(item, dynamo.AttrCreatedBy),
				CreatedAt: dynamo.TimeAt(item, dynamo.AttrCreatedAt),
				ExpiresAt: dynamo.ExpiryFrom(item),
			}
			if !invite.ExpiresAt.IsZero() && invite.ExpiresAt.Before(now) {
				continue
			}
			invites = append(invites, invite)
		}
	}
	return invites, nil
}

func (s *Store) RevokeInvite(ctx context.Context, circleID, code string) error {
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Delete: &types.Delete{
				TableName: aws.String(s.Name),
				Key:       s.Key(dynamo.CirclePK(circleID), dynamo.InviteKey(code)),
			}},
			{Delete: &types.Delete{
				TableName: aws.String(s.Name),
				Key:       s.Key(dynamo.InvitePK(code), dynamo.MetaSK),
			}},
		},
	})
	return err
}
