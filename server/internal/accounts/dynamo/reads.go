package dynamo

import (
	"context"
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
	return accounts.Profile{
		AccountID:      accountID,
		Name:           dynamoutil.StringAt(out.Item, AttrName),
		AvatarKey:      dynamoutil.StringAt(out.Item, AttrAvatarKey),
		PublicKey:      dynamoutil.BytesAt(out.Item, AttrPublicKey),
		PublicKeySetAt: dynamoutil.TimeAt(out.Item, AttrPublicKeyAt),
		CreatedAt:      dynamoutil.TimeAt(out.Item, AttrCreatedAt),
	}, nil
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
