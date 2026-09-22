package deletion

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
// the shared table for the key shapes and for reading the sign-ins that
// resolve to this account.
type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

var _ store = (*Store)(nil)

// Delete removes every sign-in that resolves to this account, then the
// account itself. Row by row rather than in a transaction, so a retry
// finds nothing left and says so by doing nothing.
//
// The lookup rows have to go first: the only record of which ones exist
// is the provider rows in the account partition, so wiping that first
// would leave an interrupted delete no way to find them again — a live
// sign-in resolving forever to an account that is gone.
//
// keep is one sort key to leave behind, empty for none: an Apple grant
// that could not be revoked, which Service.Delete banks for a retry.
func (s *Store) Delete(ctx context.Context, accountID, keep string) error {
	providers, err := s.Providers(ctx, accountID)
	if err != nil {
		return err
	}
	for _, provider := range providers {
		if err := s.detach(ctx, provider, accountID); err != nil {
			return err
		}
	}

	items, err := s.Query(ctx, dynamo.AccountPK(accountID), "")
	if err != nil {
		return err
	}
	for _, item := range items {
		sk := dynamoutil.StringAt(item, dynamoutil.SKAttr)
		if sk == keep {
			continue
		}
		if err := s.remove(ctx, dynamo.AccountPK(accountID), sk); err != nil {
			return err
		}
	}
	return nil
}

// detach drops the lookup row for one sign-in, but only while it still
// resolves here. A deletion interrupted after the lookup went and before
// the provider row did leaves the subject free to sign in again and mint
// a second account; the retry then walks the stale provider row, and
// without this condition it would take the new account's lookup with it.
func (s *Store) detach(ctx context.Context, provider accounts.Provider, accountID string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:                 aws.String(s.Name),
		Key:                       s.Key(dynamo.ProviderPK(provider.Name, provider.Subject), dynamo.LookupSK),
		ConditionExpression:       aws.String(dynamo.AttrAccountID + " = :account"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":account": dynamoutil.Str(accountID)},
	})
	// Gone already, or pointing somewhere else — either way it is not
	// this account's to remove.
	if dynamoutil.ConditionFailed(err) {
		return nil
	}
	return err
}

func (s *Store) remove(ctx context.Context, pk, sk string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Name),
		Key:       s.Key(pk, sk),
	})
	return err
}
