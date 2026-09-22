// Package dynamo is the accounts column's storage: one partition per
// account, plus a tiny partition per sign-in that points at it.
package dynamo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/util/dynamoutil"
)

type Store struct {
	client    *dynamodb.Client
	tableName string
	now       func() time.Time
}

func New(client *dynamodb.Client, tableName string) *Store {
	return &Store{client: client, tableName: tableName, now: time.Now}
}

var _ accounts.Store = (*Store)(nil)

// Key shapes. An account owns one partition; a sign-in owns its own,
// holding nothing but the account it resolves to.
const (
	accountPKPrefix  = "account#"
	providerPKPrefix = "provider#"

	profileSK  = "profile"
	deviceSK   = "device#"
	providerSK = "provider#"
	lookupSK   = "lookup"
)

func accountPK(accountID string) string { return accountPKPrefix + accountID }

// providerID is how a sign-in is named in both places it appears: the
// provider and the subject it issued, which is stable where an email
// address is not.
func providerID(provider, subject string) string { return provider + ":" + subject }

func providerPK(provider, subject string) string {
	return providerPKPrefix + providerID(provider, subject)
}

func (s *Store) key(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: str(pk),
		dynamoutil.SKAttr: str(sk),
	}
}

const (
	attrAccountID    = "accountId"
	attrName         = "name"
	attrAvatarKey    = "avatarKey"
	attrPublicKey    = "publicKey"
	attrPublicKeyAt  = "publicKeySetAt"
	attrCreatedAt    = "createdAt"
	attrPushToken    = "pushToken"
	attrPlatform     = "platform"
	attrLocale       = "locale"
	attrUpdatedAt    = "updatedAt"
	attrRefreshToken = "refreshToken"
	attrLinkedAt     = "linkedAt"
)

// Resolve is the whole of sign-in's storage: find the account this
// sign-in belongs to, or mint one. The lookup row is written with a
// condition, so two first sign-ins racing produce one account rather
// than two — the loser reads the winner's.
func (s *Store) Resolve(ctx context.Context, provider accounts.Provider) (string, bool, error) {
	accountID, err := s.lookup(ctx, provider.Name, provider.Subject)
	if err != nil || accountID != "" {
		return accountID, false, err
	}

	now := s.now()
	minted := newAccountID()
	_, err = s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{
				TableName: aws.String(s.tableName),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr: str(providerPK(provider.Name, provider.Subject)),
					dynamoutil.SKAttr: str(lookupSK),
					attrAccountID:     str(minted),
					attrCreatedAt:     millis(now),
				},
				ConditionExpression: aws.String("attribute_not_exists(pk)"),
			}},
			{Put: &types.Put{
				TableName: aws.String(s.tableName),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr: str(accountPK(minted)),
					dynamoutil.SKAttr: str(profileSK),
					attrCreatedAt:     millis(now),
				},
			}},
			{Put: &types.Put{
				TableName: aws.String(s.tableName),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr: str(accountPK(minted)),
					dynamoutil.SKAttr: str(providerSK + providerID(provider.Name, provider.Subject)),
					attrLinkedAt:      millis(now),
				},
			}},
		},
	})
	if cancelledFor(err, 0) == conditionalCheckFailed {
		// Someone else minted it in between; theirs is the account.
		accountID, err := s.lookup(ctx, provider.Name, provider.Subject)
		return accountID, false, err
	}
	if err != nil {
		return "", false, err
	}
	return minted, true, nil
}

func (s *Store) lookup(ctx context.Context, provider, subject string) (string, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.tableName),
		Key:            s.key(providerPK(provider, subject), lookupSK),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil || out.Item == nil {
		return "", err
	}
	return stringAt(out.Item, attrAccountID), nil
}

func (s *Store) GetProfile(ctx context.Context, accountID string) (accounts.Profile, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.tableName),
		Key:            s.key(accountPK(accountID), profileSK),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return accounts.Profile{}, err
	}
	if out.Item == nil {
		return accounts.Profile{}, accounts.ErrNotFound
	}
	return accounts.Profile{
		AccountID:      accountID,
		Name:           stringAt(out.Item, attrName),
		AvatarKey:      stringAt(out.Item, attrAvatarKey),
		PublicKey:      bytesAt(out.Item, attrPublicKey),
		PublicKeySetAt: timeAt(out.Item, attrPublicKeyAt),
		CreatedAt:      timeAt(out.Item, attrCreatedAt),
	}, nil
}

// SetProfile writes the name and avatar together: they are one act on a
// screen, and an avatar with nobody's name on it is no use.
func (s *Store) SetProfile(ctx context.Context, accountID, name, avatarKey string) error {
	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:        aws.String(s.tableName),
		Key:              s.key(accountPK(accountID), profileSK),
		UpdateExpression: aws.String("SET #name = :name, " + attrAvatarKey + " = :avatar"),
		// name is a reserved word in an update expression.
		ExpressionAttributeNames:  map[string]string{"#name": attrName},
		ConditionExpression:       aws.String("attribute_exists(pk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":name": str(name), ":avatar": str(avatarKey)},
	})
	if conditionFailed(err) {
		return accounts.ErrNotFound
	}
	return err
}

// SetPublicKey replaces the key members seal content keys to. Every copy
// sealed to the old one is unreadable from here, which is what the
// rewrap flow exists to repair.
func (s *Store) SetPublicKey(ctx context.Context, accountID string, publicKey []byte) error {
	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           aws.String(s.tableName),
		Key:                 s.key(accountPK(accountID), profileSK),
		UpdateExpression:    aws.String("SET " + attrPublicKey + " = :key, " + attrPublicKeyAt + " = :now"),
		ConditionExpression: aws.String("attribute_exists(pk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":key": binary(publicKey),
			":now": millis(s.now()),
		},
	})
	if conditionFailed(err) {
		return accounts.ErrNotFound
	}
	return err
}

func (s *Store) PutDevice(ctx context.Context, accountID string, device accounts.Device) error {
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr: str(accountPK(accountID)),
			dynamoutil.SKAttr: str(deviceSK + device.DeviceID),
			attrPushToken:     str(device.PushToken),
			attrPlatform:      str(device.Platform),
			attrLocale:        str(device.Locale),
			attrUpdatedAt:     millis(s.now()),
		},
	})
	return err
}

// DeleteDevice is what signing out does: push stops reaching this phone,
// and nothing else about the account changes.
func (s *Store) DeleteDevice(ctx context.Context, accountID, deviceID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key:       s.key(accountPK(accountID), deviceSK+deviceID),
	})
	return err
}

func (s *Store) ListDevices(ctx context.Context, accountID string) ([]accounts.Device, error) {
	items, err := s.query(ctx, accountPK(accountID), deviceSK)
	if err != nil {
		return nil, err
	}
	devices := make([]accounts.Device, 0, len(items))
	for _, item := range items {
		devices = append(devices, accounts.Device{
			DeviceID:  strings.TrimPrefix(stringAt(item, dynamoutil.SKAttr), deviceSK),
			PushToken: stringAt(item, attrPushToken),
			Platform:  stringAt(item, attrPlatform),
			Locale:    stringAt(item, attrLocale),
			UpdatedAt: timeAt(item, attrUpdatedAt),
		})
	}
	return devices, nil
}

func (s *Store) Providers(ctx context.Context, accountID string) ([]accounts.Provider, error) {
	items, err := s.query(ctx, accountPK(accountID), providerSK)
	if err != nil {
		return nil, err
	}
	providers := make([]accounts.Provider, 0, len(items))
	for _, item := range items {
		name, subject, _ := strings.Cut(strings.TrimPrefix(stringAt(item, dynamoutil.SKAttr), providerSK), ":")
		providers = append(providers, accounts.Provider{
			Name:         name,
			Subject:      subject,
			RefreshToken: stringAt(item, attrRefreshToken),
			LinkedAt:     timeAt(item, attrLinkedAt),
		})
	}
	return providers, nil
}

// SaveRefreshToken banks Apple's grant on the provider row it belongs
// to. Only deletion spends it, and only once.
func (s *Store) SaveRefreshToken(ctx context.Context, accountID, provider, subject, token string) error {
	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.tableName),
		Key:                       s.key(accountPK(accountID), providerSK+providerID(provider, subject)),
		UpdateExpression:          aws.String("SET " + attrRefreshToken + " = :token"),
		ConditionExpression:       aws.String("attribute_exists(sk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":token": str(token)},
	})
	if conditionFailed(err) {
		return accounts.ErrNotFound
	}
	return err
}

// Delete removes the account and every sign-in that resolves to it —
// the lookup rows last, so a sign-in mid-deletion finds an account that
// still exists rather than one that half does.
func (s *Store) Delete(ctx context.Context, accountID string) error {
	providers, err := s.Providers(ctx, accountID)
	if err != nil {
		return err
	}

	items, err := s.query(ctx, accountPK(accountID), "")
	if err != nil {
		return err
	}
	for _, item := range items {
		_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(s.tableName),
			Key:       s.key(accountPK(accountID), stringAt(item, dynamoutil.SKAttr)),
		})
		if err != nil {
			return err
		}
	}

	for _, provider := range providers {
		_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(s.tableName),
			Key:       s.key(providerPK(provider.Name, provider.Subject), lookupSK),
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// query reads one partition, or the part of it under a sort-key prefix.
func (s *Store) query(ctx context.Context, pk, prefix string) ([]map[string]types.AttributeValue, error) {
	input := &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		KeyConditionExpression: aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk": str(pk),
		},
	}
	if prefix != "" {
		input.KeyConditionExpression = aws.String("pk = :pk AND begins_with(sk, :prefix)")
		input.ExpressionAttributeValues[":prefix"] = str(prefix)
	}

	var items []map[string]types.AttributeValue
	paginator := dynamodb.NewQueryPaginator(s.client, input)
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
	}
	return items, nil
}

func newAccountID() string {
	buf := make([]byte, 16)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func str(v string) types.AttributeValue    { return &types.AttributeValueMemberS{Value: v} }
func binary(v []byte) types.AttributeValue { return &types.AttributeValueMemberB{Value: v} }

func millis(t time.Time) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(t.UnixMilli(), 10)}
}

func stringAt(item map[string]types.AttributeValue, attr string) string {
	v, _ := dynamoutil.AttrString(item, attr)
	return v
}

func bytesAt(item map[string]types.AttributeValue, attr string) []byte {
	v, _ := dynamoutil.AttrBytes(item, attr)
	return v
}

func timeAt(item map[string]types.AttributeValue, attr string) time.Time {
	v, err := dynamoutil.AttrInt(item, attr)
	if err != nil || v == 0 {
		return time.Time{}
	}
	return time.UnixMilli(v)
}

func conditionFailed(err error) bool {
	var failed *types.ConditionalCheckFailedException
	return errors.As(err, &failed)
}

const conditionalCheckFailed = "ConditionalCheckFailed"

func cancelledFor(err error, i int) string {
	var cancelled *types.TransactionCanceledException
	if !errors.As(err, &cancelled) || i >= len(cancelled.CancellationReasons) {
		return ""
	}
	return aws.ToString(cancelled.CancellationReasons[i].Code)
}
