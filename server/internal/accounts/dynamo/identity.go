package dynamo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/util/dynamoutil"
)

// Resolve is the whole of sign-in's storage: find the account this
// sign-in belongs to, or mint one. The lookup row is written with a
// condition, so two first sign-ins racing produce one account rather
// than two — the loser reads the winner's.
func (t *Table) Resolve(ctx context.Context, provider accounts.Provider) (string, bool, error) {
	accountID, err := t.lookup(ctx, provider.Name, provider.Subject)
	if err != nil || accountID != "" {
		return accountID, false, err
	}

	now := t.Now()
	minted := newAccountID()
	_, err = t.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{
				TableName: aws.String(t.Name),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr: dynamoutil.Str(ProviderPK(provider.Name, provider.Subject)),
					dynamoutil.SKAttr: dynamoutil.Str(LookupSK),
					AttrAccountID:     dynamoutil.Str(minted),
					AttrCreatedAt:     dynamoutil.Millis(now),
				},
				ConditionExpression: aws.String("attribute_not_exists(pk)"),
			}},
			{Put: &types.Put{
				TableName: aws.String(t.Name),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr: dynamoutil.Str(AccountPK(minted)),
					dynamoutil.SKAttr: dynamoutil.Str(ProfileSK),
					AttrCreatedAt:     dynamoutil.Millis(now),
				},
			}},
			{Put: &types.Put{
				TableName: aws.String(t.Name),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr: dynamoutil.Str(AccountPK(minted)),
					dynamoutil.SKAttr: dynamoutil.Str(ProviderKey(provider.Name, provider.Subject)),
					AttrLinkedAt:      dynamoutil.Millis(now),
				},
			}},
		},
	})
	if dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed {
		// Someone else minted it in between; theirs is the account.
		accountID, err := t.lookup(ctx, provider.Name, provider.Subject)
		return accountID, false, err
	}
	if err != nil {
		return "", false, err
	}
	return minted, true, nil
}

// SaveRefreshToken banks Apple's grant on the provider row it belongs
// to. It lives here beside Resolve rather than in the sign-in slice
// because it is the other half of the same row: the sign-in that
// resolved is the sign-in the grant belongs to. Only deletion spends it,
// and only once.
func (t *Table) SaveRefreshToken(ctx context.Context, accountID, provider, subject, token string) error {
	_, err := t.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(t.Name),
		Key:                       t.Key(AccountPK(accountID), ProviderKey(provider, subject)),
		UpdateExpression:          aws.String("SET " + AttrRefreshToken + " = :token"),
		ConditionExpression:       aws.String("attribute_exists(sk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":token": dynamoutil.Str(token)},
	})
	if dynamoutil.ConditionFailed(err) {
		return accounts.ErrNotFound
	}
	return err
}

// Providers is the sign-ins that resolve to this account. Deletion reads
// it to revoke the grant behind an Apple sign-in, and to know which
// lookup rows to remove.
func (t *Table) Providers(ctx context.Context, accountID string) ([]accounts.Provider, error) {
	items, err := t.Query(ctx, AccountPK(accountID), ProviderSK)
	if err != nil {
		return nil, err
	}
	providers := make([]accounts.Provider, 0, len(items))
	for _, item := range items {
		name, subject, _ := strings.Cut(strings.TrimPrefix(dynamoutil.StringAt(item, dynamoutil.SKAttr), ProviderSK), ":")
		providers = append(providers, accounts.Provider{
			Name:         name,
			Subject:      subject,
			RefreshToken: dynamoutil.StringAt(item, AttrRefreshToken),
			LinkedAt:     dynamoutil.TimeAt(item, AttrLinkedAt),
		})
	}
	return providers, nil
}

func (t *Table) lookup(ctx context.Context, provider, subject string) (string, error) {
	out, err := t.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(t.Name),
		Key:            t.Key(ProviderPK(provider, subject), LookupSK),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil || out.Item == nil {
		return "", err
	}
	return dynamoutil.StringAt(out.Item, AttrAccountID), nil
}

func newAccountID() string {
	buf := make([]byte, 16)
	// crypto/rand.Read is documented never to return an error.
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
