package devices

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/util/dynamoutil"
)

// Store is this slice's own writes against the accounts table. It embeds
// the shared table for the key shapes and the reads more than one slice
// needs.
type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

var _ store = (*Store)(nil)

func (s *Store) PutDevice(ctx context.Context, accountID string, device accounts.Device) error {
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Name),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr:    dynamoutil.Str(dynamo.AccountPK(accountID)),
			dynamoutil.SKAttr:    dynamoutil.Str(dynamo.DeviceSK + device.DeviceID),
			dynamo.AttrPushToken: dynamoutil.Str(device.PushToken),
			dynamo.AttrPlatform:  dynamoutil.Str(device.Platform),
			dynamo.AttrLocale:    dynamoutil.Str(device.Locale),
			dynamo.AttrUpdatedAt: dynamoutil.Millis(s.Now()),
		},
	})
	return err
}

// DeleteDevice is what signing out does: push stops reaching this phone,
// and nothing else about the account changes.
func (s *Store) DeleteDevice(ctx context.Context, accountID, deviceID string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Name),
		Key:       s.Key(dynamo.AccountPK(accountID), dynamo.DeviceSK+deviceID),
	})
	return err
}
