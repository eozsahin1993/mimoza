package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/account"
	"mimoza-relay/internal/util/dynamoutil"
)

type Store struct {
	client    *dynamodb.Client
	tableName string
}

func New(client *dynamodb.Client, tableName string) *Store {
	return &Store{client: client, tableName: tableName}
}

var _ account.Store = (*Store)(nil)

// manifestSK is fixed: the accounts table has a sort key, and the
// manifest is the only row under its bare account-id partition.
const manifestSK = "manifest"

func manifestKey(accountID string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: accountID},
		dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: manifestSK},
	}
}

func (s *Store) GetManifest(ctx context.Context, accountID string) (account.Manifest, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.tableName),
		Key:            manifestKey(accountID),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return account.Manifest{}, err
	}
	if out.Item == nil {
		return account.Manifest{}, nil
	}
	blobAttr, ok := out.Item["blob"].(*types.AttributeValueMemberB)
	if !ok {
		return account.Manifest{}, nil
	}

	// Absent version attribute reads as 0: every manifest written before
	// versioning has none, and those rows still have to be writable.
	var version int64
	if versionAttr, ok := out.Item["version"].(*types.AttributeValueMemberN); ok {
		if parsed, err := strconv.ParseInt(versionAttr.Value, 10, 64); err == nil {
			version = parsed
		}
	}
	return account.Manifest{Blob: blobAttr.Value, Version: version}, nil
}

func (s *Store) PutManifest(ctx context.Context, accountID string, blob []byte, expectedVersion int64) error {
	// Two ways to be at version 0 — no row at all, or a row predating the
	// version attribute — and a first write has to succeed against either.
	condition := "version = :expected"
	values := map[string]types.AttributeValue{
		":expected": &types.AttributeValueMemberN{Value: strconv.FormatInt(expectedVersion, 10)},
	}
	if expectedVersion == 0 {
		condition = fmt.Sprintf("attribute_not_exists(%s) OR attribute_not_exists(version)", dynamoutil.PKAttr)
		values = nil
	}

	item := manifestKey(accountID)
	item["blob"] = &types.AttributeValueMemberB{Value: blob}
	item["version"] = &types.AttributeValueMemberN{Value: strconv.FormatInt(expectedVersion+1, 10)}
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:                 aws.String(s.tableName),
		Item:                      item,
		ConditionExpression:       aws.String(condition),
		ExpressionAttributeValues: values,
	})

	var condFailed *types.ConditionalCheckFailedException
	if errors.As(err, &condFailed) {
		return account.ErrVersionMismatch
	}
	return err
}

func (s *Store) DeleteManifest(ctx context.Context, accountID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key:       manifestKey(accountID),
	})
	return err
}
