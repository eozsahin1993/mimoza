package devicelink

import (
	"context"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/util/dynamoutil"
)

// Store is this slice's own writes against the accounts table.
type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

var _ store = (*Store)(nil)

func (s *Store) PutLink(ctx context.Context, accountID string, link accounts.DeviceLink) error {
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Name),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr:    dynamoutil.Str(dynamo.AccountPK(accountID)),
			dynamoutil.SKAttr:    dynamoutil.Str(dynamo.DeviceLinkKey(link.SessionID)),
			dynamo.AttrPublicKey: dynamoutil.Binary(link.PublicKey),
			dynamo.AttrCreatedAt: dynamoutil.Millis(link.CreatedAt),
			dynamo.AttrExpiresAt: dynamoutil.Num(link.ExpiresAt.Unix()),
		},
	})
	return err
}

func (s *Store) GetLink(ctx context.Context, accountID, sessionID string) (accounts.DeviceLink, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Name),
		Key:       s.Key(dynamo.AccountPK(accountID), dynamo.DeviceLinkKey(sessionID)),
	})
	if err != nil {
		return accounts.DeviceLink{}, err
	}
	if out.Item == nil {
		return accounts.DeviceLink{}, accounts.ErrNotFound
	}
	link := accounts.DeviceLink{
		SessionID:     sessionID,
		PublicKey:     dynamoutil.BytesAt(out.Item, dynamo.AttrPublicKey),
		SealedKeypair: dynamoutil.BytesAt(out.Item, dynamo.AttrSealedKeypair),
		CreatedAt:     dynamoutil.TimeAt(out.Item, dynamo.AttrCreatedAt),
		ExpiresAt:     time.Unix(dynamoutil.IntAt(out.Item, dynamo.AttrExpiresAt), 0),
	}
	if link.Delivered() {
		link.DeliveredAt = dynamoutil.TimeAt(out.Item, dynamo.AttrDeliveredAt)
	}
	// TTL sweeps lazily, so an expired row can still be sitting here.
	// Without this the collection window would be however long the sweeper
	// took, not the hour the session was opened for.
	if !link.ExpiresAt.After(s.Now()) {
		return accounts.DeviceLink{}, accounts.ErrNotFound
	}
	return link, nil
}

// SaveSealedKeypair writes the sealed keypair, once. The condition is the
// guarantee: still open, still unanswered, not expired, all decided by
// DynamoDB rather than by a read taken a moment earlier.
func (s *Store) SaveSealedKeypair(ctx context.Context, accountID, sessionID string, sealed []byte) error {
	now := s.Now()
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:        aws.String(s.Name),
		Key:              s.Key(dynamo.AccountPK(accountID), dynamo.DeviceLinkKey(sessionID)),
		UpdateExpression: aws.String("SET #sealed = :sealed, #deliveredAt = :now"),
		ConditionExpression: aws.String(
			"attribute_exists(#sk) AND attribute_not_exists(#sealed) AND #expiresAt > :nowSeconds"),
		ExpressionAttributeNames: map[string]string{
			"#sk":          dynamoutil.SKAttr,
			"#sealed":      dynamo.AttrSealedKeypair,
			"#deliveredAt": dynamo.AttrDeliveredAt,
			"#expiresAt":   dynamo.AttrExpiresAt,
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":sealed":     dynamoutil.Binary(sealed),
			":now":        dynamoutil.Millis(now),
			":nowSeconds": dynamoutil.Num(now.Unix()),
		},
	})
	if dynamoutil.ConditionFailed(err) {
		return s.whySaveFailed(ctx, accountID, sessionID)
	}
	return err
}

// whySaveFailed splits the one failed condition back into the cases the
// caller answers differently: gone or expired is a 404, already answered
// is a 409. Error path only, so a successful send stays one write.
func (s *Store) whySaveFailed(ctx context.Context, accountID, sessionID string) error {
	link, err := s.GetLink(ctx, accountID, sessionID)
	if err != nil {
		return err
	}
	if link.Delivered() {
		return accounts.ErrLinkAnswered
	}
	return accounts.ErrNotFound
}
