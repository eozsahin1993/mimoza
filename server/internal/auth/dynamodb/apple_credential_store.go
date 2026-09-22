package dynamodb

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/dynamoutil"
)

// applePKPrefix keeps these rows in their own key space inside whatever
// table they share. They live in the accounts table, not the sessions
// one, because sessions are TTL'd and these must outlive every session
// the account ever has.
const applePKPrefix = "apple-refresh#"

// The accounts table has a sort key; this row is alone in its partition,
// so a fixed one is enough.
const appleSK = "apple-refresh"

// AppleCredentialStore implements auth.AppleCredentialStore against the
// accounts table. It holds a sign-in provider credential, so it belongs
// to the auth column even though it is account-keyed.
type AppleCredentialStore struct {
	client    *dynamodb.Client
	tableName string
}

func NewAppleCredentialStore(client *dynamodb.Client, tableName string) *AppleCredentialStore {
	return &AppleCredentialStore{client: client, tableName: tableName}
}

var _ auth.AppleCredentialStore = (*AppleCredentialStore)(nil)

func (s *AppleCredentialStore) key(accountID string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: applePKPrefix + accountID},
		dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: appleSK},
	}
}

func (s *AppleCredentialStore) SaveAppleRefreshToken(ctx context.Context, accountID, refreshToken string) error {
	item := s.key(accountID)
	item["refreshToken"] = &types.AttributeValueMemberS{Value: refreshToken}
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item:      item,
	})
	return err
}

func (s *AppleCredentialStore) GetAppleRefreshToken(ctx context.Context, accountID string) (string, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.tableName),
		Key:            s.key(accountID),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return "", err
	}
	if out.Item == nil {
		return "", nil
	}
	token, _ := dynamoutil.AttrString(out.Item, "refreshToken")
	return token, nil
}

func (s *AppleCredentialStore) DeleteAppleRefreshToken(ctx context.Context, accountID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key:       s.key(accountID),
	})
	return err
}
