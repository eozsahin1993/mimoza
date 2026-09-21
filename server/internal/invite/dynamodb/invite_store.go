// Package dynamodb implements invite.Store against a single DynamoDB
// table. Single-table design, same shape as logstore/dynamodb: PK =
// inviteTag (hash(invite_code) — the relay never sees the code itself),
// SK distinguishes the invite row from each requester's row.
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/invite"
	"mimoza-relay/internal/util/dynamoutil"
)

const (
	inviteSK        = "invite"
	requestSKPrefix = "request#"
)

func requestSK(requesterID string) string {
	return requestSKPrefix + requesterID
}

type Store struct {
	client           *dynamodb.Client
	tableName        string
	retentionSeconds int64
}

// New takes the retention already resolved (config.InviteRetentionDays),
// the same number push/dynamodb gets for invite addresses.
func New(client *dynamodb.Client, tableName string, retentionDays int64) *Store {
	return &Store{client: client, tableName: tableName, retentionSeconds: retentionDays * 24 * 60 * 60}
}

var _ invite.Store = (*Store)(nil)

// CreateInvite is the one proactive server write in the whole invite
// flow, made once at invite-creation time.
func (s *Store) CreateInvite(ctx context.Context, inviteTag string, encryptedPreview []byte) error {
	expiresAt := dynamoutil.NowMillis()/1000 + s.retentionSeconds
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr:  &types.AttributeValueMemberS{Value: inviteTag},
			dynamoutil.SKAttr:  &types.AttributeValueMemberS{Value: inviteSK},
			"encryptedPreview": &types.AttributeValueMemberB{Value: encryptedPreview},
			"expiresAt":        &types.AttributeValueMemberN{Value: strconv.FormatInt(expiresAt, 10)},
		},
		ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", dynamoutil.PKAttr)),
	})
	var condFailed *types.ConditionalCheckFailedException
	if errors.As(err, &condFailed) {
		return invite.ErrInviteExists
	}
	return err
}

func (s *Store) GetInvite(ctx context.Context, inviteTag string) ([]byte, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: inviteTag},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: inviteSK},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	blobAttr, ok := out.Item["encryptedPreview"].(*types.AttributeValueMemberB)
	if !ok {
		return nil, nil
	}
	return blobAttr.Value, nil
}

// PutJoinRequest creates the requester's row if one doesn't already exist.
// The requester picks its own id randomly, so calling this again with the
// same (inviteTag, requesterID) is always a retry of the same submission —
// the ConditionalCheckFailedException from a losing race is swallowed
// rather than surfaced as an error, same idempotent-retry idiom as
// logstore/dynamodb's CommitEntry.
func (s *Store) PutJoinRequest(ctx context.Context, inviteTag, requesterID string, encryptedRequest []byte) error {
	createdAt := dynamoutil.NowMillis()
	expiresAt := createdAt/1000 + s.retentionSeconds
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr:  &types.AttributeValueMemberS{Value: inviteTag},
			dynamoutil.SKAttr:  &types.AttributeValueMemberS{Value: requestSK(requesterID)},
			"requesterId":      &types.AttributeValueMemberS{Value: requesterID},
			"encryptedRequest": &types.AttributeValueMemberB{Value: encryptedRequest},
			"createdAt":        &types.AttributeValueMemberN{Value: strconv.FormatInt(createdAt, 10)},
			"expiresAt":        &types.AttributeValueMemberN{Value: strconv.FormatInt(expiresAt, 10)},
		},
		ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", dynamoutil.PKAttr)),
	})
	if err == nil {
		return nil
	}
	var condFailed *types.ConditionalCheckFailedException
	if errors.As(err, &condFailed) {
		return nil // already created by an earlier attempt — idempotent retry
	}
	return err
}

func (s *Store) ListJoinRequests(ctx context.Context, inviteTag string) ([]invite.JoinRequest, error) {
	out, err := s.client.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND begins_with(%s, :prefix)", dynamoutil.PKAttr, dynamoutil.SKAttr)),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: inviteTag},
			":prefix": &types.AttributeValueMemberS{Value: requestSKPrefix},
		},
	})
	if err != nil {
		return nil, err
	}

	requests := make([]invite.JoinRequest, 0, len(out.Items))
	for _, item := range out.Items {
		jr, err := itemToJoinRequest(item)
		if err != nil {
			return nil, err
		}
		requests = append(requests, jr)
	}
	return requests, nil
}

func (s *Store) GetJoinRequest(ctx context.Context, inviteTag, requesterID string) (*invite.JoinRequest, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: inviteTag},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: requestSK(requesterID)},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	jr, err := itemToJoinRequest(out.Item)
	if err != nil {
		return nil, err
	}
	return &jr, nil
}

// ApproveJoinRequest sets the sealed-box-encrypted approval payload on an
// existing request row — attribute_exists(pk) so approving a nonexistent
// (or already-expired-and-evicted) row returns a clear error rather than
// silently creating a new one. Deliberately does not touch expiresAt: the
// row's retention clock started when the request was submitted, and
// approving it shouldn't extend how long an already-answered request
// lingers server-side.
func (s *Store) ApproveJoinRequest(ctx context.Context, inviteTag, requesterID string, encryptedApproval []byte) error {
	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: inviteTag},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: requestSK(requesterID)},
		},
		UpdateExpression: aws.String("SET encryptedApproval = :approval"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":approval": &types.AttributeValueMemberB{Value: encryptedApproval},
		},
		ConditionExpression: aws.String(fmt.Sprintf("attribute_exists(%s)", dynamoutil.PKAttr)),
	})
	if err != nil {
		var condFailed *types.ConditionalCheckFailedException
		if errors.As(err, &condFailed) {
			return invite.ErrJoinRequestNotFound
		}
		return err
	}
	return nil
}

// DeleteJoinRequest removes a requester's row immediately — "not now",
// or responding to a suspected leak, without waiting out TTL. Deleting an
// already-gone item is a no-op in DynamoDB, so this is safely callable
// even for a row that doesn't exist or already expired.
func (s *Store) DeleteJoinRequest(ctx context.Context, inviteTag, requesterID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: inviteTag},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: requestSK(requesterID)},
		},
	})
	return err
}

func itemToJoinRequest(item map[string]types.AttributeValue) (invite.JoinRequest, error) {
	requesterID, ok := dynamoutil.AttrString(item, "requesterId")
	if !ok {
		return invite.JoinRequest{}, errors.New("join request item missing requesterId")
	}
	reqAttr, ok := item["encryptedRequest"].(*types.AttributeValueMemberB)
	if !ok {
		return invite.JoinRequest{}, errors.New("join request item missing encryptedRequest")
	}
	createdAt, err := dynamoutil.AttrInt(item, "createdAt")
	if err != nil {
		return invite.JoinRequest{}, err
	}

	var encryptedApproval []byte
	if approvalAttr, ok := item["encryptedApproval"].(*types.AttributeValueMemberB); ok {
		encryptedApproval = approvalAttr.Value
	}

	return invite.JoinRequest{
		RequesterID:       requesterID,
		EncryptedRequest:  reqAttr.Value,
		EncryptedApproval: encryptedApproval,
		CreatedAt:         createdAt,
	}, nil
}
