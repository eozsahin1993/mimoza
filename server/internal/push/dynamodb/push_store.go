// Package dynamodb implements push.Store. Same single-table shape as
// invite/dynamodb: PK = pushRoutingId, SK splits prefs from device rows.
//
// Circle addresses never expire: a routing id is how a device stays
// reachable between posts. Invite and pending-request addresses do (see
// push.PushKind.Temporary), through the table's TTL on expiresAt.
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/push"
	"mimoza-relay/internal/util/dynamoutil"
)

const (
	prefsSK        = "prefs"
	deviceSKPrefix = "device#"
)

func (s *Store) expiresAt() types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(dynamoutil.NowMillis()/1000+s.temporaryRetentionSeconds, 10)}
}

func deviceSK(deviceID string) string {
	return deviceSKPrefix + deviceID
}

type Store struct {
	client    *dynamodb.Client
	tableName string
	// How long an invite or pending-request address lasts. Always the
	// invite retention, passed in by the caller (see app.go).
	temporaryRetentionSeconds int64
}

func New(client *dynamodb.Client, tableName string, inviteRetentionDays int64) *Store {
	return &Store{client: client, tableName: tableName, temporaryRetentionSeconds: inviteRetentionDays * 24 * 60 * 60}
}

var _ push.Store = (*Store)(nil)

func (s *Store) PutPrefs(ctx context.Context, pushRoutingID string, prefs push.Prefs) error {
	item := map[string]types.AttributeValue{
		dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
		dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: prefsSK},
		"kind":            &types.AttributeValueMemberS{Value: string(prefs.Kind)},
		"pushFanoutHash":  &types.AttributeValueMemberB{Value: prefs.PushFanoutHash},
		"ownerHash":       &types.AttributeValueMemberB{Value: prefs.OwnerHash},
		"categoryMask":    &types.AttributeValueMemberN{Value: strconv.FormatInt(prefs.CategoryMask, 10)},
		"keyVersion":      &types.AttributeValueMemberN{Value: strconv.FormatInt(prefs.KeyVersion, 10)},
		"silenced":        &types.AttributeValueMemberBOOL{Value: prefs.Silenced},
	}
	// A whole-item put, so leaving expiresAt out is what clears it.
	if prefs.Kind.Temporary() {
		item["expiresAt"] = s.expiresAt()
	}

	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item:      item,
		// A new row, or the same owner.
		ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s) OR ownerHash = :owner", dynamoutil.PKAttr)),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":owner": &types.AttributeValueMemberB{Value: prefs.OwnerHash},
		},
	})
	var condFailed *types.ConditionalCheckFailedException
	if errors.As(err, &condFailed) {
		return push.ErrNotOwner
	}
	if err != nil {
		return fmt.Errorf("put push prefs: %w", err)
	}
	return nil
}

func (s *Store) GetPrefs(ctx context.Context, pushRoutingID string) (*push.Prefs, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: prefsSK},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get push prefs: %w", err)
	}
	if out.Item == nil {
		return nil, push.ErrPushRoutingNotFound
	}

	// A row missing these wasn't written by this code — reading it as
	// zeroes would authorize an empty token.
	pushFanoutHash, ok := dynamoutil.AttrBytes(out.Item, "pushFanoutHash")
	if !ok {
		return nil, fmt.Errorf("push prefs row for %q has no pushFanoutHash", pushRoutingID)
	}
	categoryMask, err := dynamoutil.AttrInt(out.Item, "categoryMask")
	if err != nil {
		return nil, fmt.Errorf("push prefs row for %q: %w", pushRoutingID, err)
	}
	keyVersion, err := dynamoutil.AttrInt(out.Item, "keyVersion")
	if err != nil {
		return nil, fmt.Errorf("push prefs row for %q: %w", pushRoutingID, err)
	}

	// Not required like pushFanoutHash: a send never reads it, and an
	// empty one authorizes no write (see Service.authorize).
	ownerHash, _ := dynamoutil.AttrBytes(out.Item, "ownerHash")

	// Rows from before kinds existed are all circles.
	kind := push.KindCircle
	if stored, ok := dynamoutil.AttrString(out.Item, "kind"); ok {
		kind = push.PushKind(stored)
	}

	prefs := push.Prefs{
		Kind:           kind,
		PushFanoutHash: pushFanoutHash,
		OwnerHash:      ownerHash,
		CategoryMask:   categoryMask,
		KeyVersion:     keyVersion,
		Silenced:       dynamoutil.AttrBool(out.Item, "silenced"),
	}
	return &prefs, nil
}

func (s *Store) SetSilenced(ctx context.Context, pushRoutingID string, silenced bool) error {
	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: prefsSK},
		},
		UpdateExpression: aws.String("SET silenced = :silenced"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":silenced": &types.AttributeValueMemberBOOL{Value: silenced},
		},
		ConditionExpression: aws.String(fmt.Sprintf("attribute_exists(%s)", dynamoutil.PKAttr)),
	})
	if err != nil {
		var condFailed *types.ConditionalCheckFailedException
		if errors.As(err, &condFailed) {
			return push.ErrPushRoutingNotFound
		}
		return fmt.Errorf("set push silenced: %w", err)
	}
	return nil
}

func (s *Store) PutDevice(ctx context.Context, pushRoutingID string, device push.Device) error {
	item := map[string]types.AttributeValue{
		dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
		dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: deviceSK(device.DeviceID)},
		"pushToken":       &types.AttributeValueMemberB{Value: device.PushToken},
		"platform":        &types.AttributeValueMemberS{Value: device.Platform},
		"enabled":         &types.AttributeValueMemberBOOL{Value: device.Enabled},
	}
	if device.Temporary {
		item["expiresAt"] = s.expiresAt()
	}
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item:      item,
	})
	if err != nil {
		return fmt.Errorf("put push device: %w", err)
	}
	return nil
}

func (s *Store) ListDevices(ctx context.Context, pushRoutingID string) ([]push.Device, error) {
	out, err := s.client.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND begins_with(%s, :prefix)", dynamoutil.PKAttr, dynamoutil.SKAttr)),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: pushRoutingID},
			":prefix": &types.AttributeValueMemberS{Value: deviceSKPrefix},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("list push devices: %w", err)
	}

	devices := make([]push.Device, 0, len(out.Items))
	for _, item := range out.Items {
		sk, ok := dynamoutil.AttrString(item, dynamoutil.SKAttr)
		if !ok {
			continue
		}
		pushToken, ok := dynamoutil.AttrBytes(item, "pushToken")
		if !ok {
			continue
		}
		platform, _ := dynamoutil.AttrString(item, "platform")
		devices = append(devices, push.Device{
			DeviceID:  strings.TrimPrefix(sk, deviceSKPrefix),
			PushToken: pushToken,
			Platform:  platform,
			Enabled:   dynamoutil.AttrBool(item, "enabled"),
		})
	}
	return devices, nil
}

func (s *Store) DeleteDevice(ctx context.Context, pushRoutingID, deviceID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: deviceSK(deviceID)},
		},
	})
	if err != nil {
		return fmt.Errorf("delete push device: %w", err)
	}
	return nil
}

// Not transactional. A partial failure orphans device rows, which is
// harmless: a send reads prefs first, so they're already unreachable.
func (s *Store) DeleteRouting(ctx context.Context, pushRoutingID string) error {
	devices, err := s.ListDevices(ctx, pushRoutingID)
	if err != nil {
		return err
	}

	var errs []error
	for _, device := range devices {
		if err := s.DeleteDevice(ctx, pushRoutingID, device.DeviceID); err != nil {
			errs = append(errs, err)
		}
	}

	_, err = s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: prefsSK},
		},
	})
	if err != nil {
		errs = append(errs, fmt.Errorf("delete push prefs: %w", err))
	}
	return errors.Join(errs...)
}
