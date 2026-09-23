package dynamo

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/util/dynamoutil"
)

// The reads here are the ones more than one slice needs: a profile is
// read by the slice that writes it and by every roster the circles
// column renders, and devices are listed by push rather than by the
// slice that registers them.

func (t *Table) GetProfile(ctx context.Context, accountID string) (accounts.Profile, error) {
	out, err := t.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(t.Name),
		Key:            t.Key(AccountPK(accountID), ProfileSK),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return accounts.Profile{}, err
	}
	if out.Item == nil {
		return accounts.Profile{}, accounts.ErrNotFound
	}
	return profileFrom(accountID, out.Item), nil
}

func profileFrom(accountID string, item map[string]types.AttributeValue) accounts.Profile {
	return accounts.Profile{
		AccountID:      accountID,
		Name:           dynamoutil.StringAt(item, AttrName),
		AvatarID:       dynamoutil.StringAt(item, AttrAvatarID),
		PublicKey:      dynamoutil.BytesAt(item, AttrPublicKey),
		PublicKeySetAt: dynamoutil.TimeAt(item, AttrPublicKeyAt),
		CreatedAt:      dynamoutil.TimeAt(item, AttrCreatedAt),
	}
}

// GetProfiles reads many at once, for the places that render a list of
// people: a roster, or the requests waiting on an admin. Accounts with
// no row are absent from the map rather than an error, since a member
// can be deleted between the roster read and this one.
//
// Keys are batched in hundreds because that is BatchGetItem's limit, and
// DynamoDB may return some keys unprocessed under load, which is a
// throttle rather than a failure: those are retried until the batch
// stops shrinking.
func (t *Table) GetProfiles(ctx context.Context, accountIDs []string) (map[string]accounts.Profile, error) {
	profiles := make(map[string]accounts.Profile, len(accountIDs))
	for _, batch := range batches(unique(accountIDs), 100) {
		keys := make([]map[string]types.AttributeValue, 0, len(batch))
		for _, accountID := range batch {
			keys = append(keys, t.Key(AccountPK(accountID), ProfileSK))
		}

		for len(keys) > 0 {
			out, err := t.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{
				RequestItems: map[string]types.KeysAndAttributes{
					t.Name: {Keys: keys},
				},
			})
			if err != nil {
				return nil, err
			}
			for _, item := range out.Responses[t.Name] {
				accountID := strings.TrimPrefix(dynamoutil.StringAt(item, dynamoutil.PKAttr), AccountPKPrefix)
				profiles[accountID] = profileFrom(accountID, item)
			}

			unprocessed := out.UnprocessedKeys[t.Name].Keys
			if len(unprocessed) >= len(keys) {
				// Not shrinking: retrying the same batch forever would
				// hang the request instead of answering it.
				return nil, fmt.Errorf("accounts: batch read stalled with %d keys left", len(unprocessed))
			}
			keys = unprocessed
		}
	}
	return profiles, nil
}

// unique keeps one key per account: a batch with the same key twice is
// rejected outright, and a roster read can ask for the same person as
// both actor and subject.
func unique(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func batches(ids []string, size int) [][]string {
	var out [][]string
	for start := 0; start < len(ids); start += size {
		end := min(start+size, len(ids))
		out = append(out, ids[start:end])
	}
	return out
}

func (t *Table) ListDevices(ctx context.Context, accountID string) ([]accounts.Device, error) {
	items, err := t.Query(ctx, AccountPK(accountID), DeviceSK)
	if err != nil {
		return nil, err
	}
	devices := make([]accounts.Device, 0, len(items))
	for _, item := range items {
		devices = append(devices, accounts.Device{
			DeviceID:  strings.TrimPrefix(dynamoutil.StringAt(item, dynamoutil.SKAttr), DeviceSK),
			PushToken: dynamoutil.StringAt(item, AttrPushToken),
			Platform:  dynamoutil.StringAt(item, AttrPlatform),
			Locale:    dynamoutil.StringAt(item, AttrLocale),
			UpdatedAt: dynamoutil.TimeAt(item, AttrUpdatedAt),
		})
	}
	return devices, nil
}

// Query reads one partition, or the part of it under a sort-key prefix.
// An account's partition holds a profile, a handful of devices and a
// sign-in or two, so it always fits a page or three.
//
// Consistently, because deletion walks this to find the lookup rows it
// has to chase: a provider row written moments earlier and missed here
// would leave a sign-in resolving to an account that is gone.
func (t *Table) Query(ctx context.Context, pk, prefix string) ([]map[string]types.AttributeValue, error) {
	input := &dynamodb.QueryInput{
		TableName:              aws.String(t.Name),
		ConsistentRead:         aws.Bool(true),
		KeyConditionExpression: aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk": dynamoutil.Str(pk),
		},
	}
	if prefix != "" {
		input.KeyConditionExpression = aws.String("pk = :pk AND begins_with(sk, :prefix)")
		input.ExpressionAttributeValues[":prefix"] = dynamoutil.Str(prefix)
	}

	var items []map[string]types.AttributeValue
	paginator := dynamodb.NewQueryPaginator(t.Client, input)
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
	}
	return items, nil
}
