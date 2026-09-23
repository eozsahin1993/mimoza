package profile

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

// SetProfile writes the name and avatar together: they are one act on a
// screen, and an avatar with nobody's name on it is no use.
func (s *Store) SetProfile(ctx context.Context, accountID, name, avatarID string) error {
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:        aws.String(s.Name),
		Key:              s.Key(dynamo.AccountPK(accountID), dynamo.ProfileSK),
		UpdateExpression: aws.String("SET #name = :name, " + dynamo.AttrAvatarID + " = :avatar"),
		// name is a reserved word in an update expression.
		ExpressionAttributeNames:  map[string]string{"#name": dynamo.AttrName},
		ConditionExpression:       aws.String("attribute_exists(pk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":name": dynamoutil.Str(name), ":avatar": dynamoutil.Str(avatarID)},
	})
	if dynamoutil.ConditionFailed(err) {
		return accounts.ErrNotFound
	}
	return err
}

// SetPublicKey replaces the key members seal content keys to. Every copy
// sealed to the old one is unreadable from here, which is what the
// rewrap flow exists to repair.
func (s *Store) SetPublicKey(ctx context.Context, accountID string, publicKey []byte) error {
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           aws.String(s.Name),
		Key:                 s.Key(dynamo.AccountPK(accountID), dynamo.ProfileSK),
		UpdateExpression:    aws.String("SET " + dynamo.AttrPublicKey + " = :key, " + dynamo.AttrPublicKeyAt + " = :now"),
		ConditionExpression: aws.String("attribute_exists(pk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":key": dynamoutil.Binary(publicKey),
			":now": dynamoutil.Millis(s.Now()),
		},
	})
	if dynamoutil.ConditionFailed(err) {
		return accounts.ErrNotFound
	}
	return err
}
