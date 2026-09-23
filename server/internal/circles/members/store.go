package members

import (
	"context"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/circles"
	"mimoza-relay/internal/circles/dynamo"
	"mimoza-relay/internal/util/dynamoutil"
)

// Store is this slice's own reads and writes against the circles table.
// It embeds the shared table for the key shapes, the item encoding and
// the handful of reads more than one slice needs.
type Store struct {
	*dynamo.Table
}

func NewStore(table *dynamo.Table) *Store { return &Store{Table: table} }

// The slice's service depends on the interface, not this type; the
// assertion is what makes a drift between them a build failure here
// rather than a wiring failure in internal/app.
var _ store = (*Store)(nil)

// ListMemberships is GET /circles: every circle this account belongs
// to. The index is
// keys-only, so the circles themselves are read after it.
func (s *Store) ListMemberships(ctx context.Context, accountID string) ([]circles.Membership, error) {
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:              aws.String(s.Name),
		IndexName:              aws.String(dynamo.ByAccountIndex),
		KeyConditionExpression: aws.String(dynamo.ByAccountPK + " = :account AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":account": dynamoutil.Str(accountID),
			":prefix":  dynamoutil.Str(dynamo.MemberSK),
		},
	})

	var memberships []circles.Membership
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, row := range page.Items {
			circleID := strings.TrimPrefix(dynamoutil.StringAt(row, dynamoutil.PKAttr), dynamo.CirclePKPrefix)
			member, err := s.GetMember(ctx, circleID, accountID)
			if err != nil {
				return nil, err
			}
			circle, err := s.GetCircle(ctx, circleID)
			if err != nil {
				// A membership whose circle has been deleted is already
				// gone as far as its owner is concerned.
				if err == circles.ErrCircleNotFound {
					continue
				}
				return nil, err
			}
			memberships = append(memberships, circles.Membership{
				Circle:      circle,
				Role:        member.Role,
				NotifyLevel: member.NotifyLevel,
				NeedsRewrap: member.NeedsRewrap,
			})
		}
	}
	return memberships, nil
}

// SetRole promotes or demotes, and records it. The roster version moves
// so every device refetches.
func (s *Store) SetRole(ctx context.Context, circleID, accountID, role, actorID, subjectName string) error {
	current, err := s.GetMember(ctx, circleID, accountID)
	if err != nil {
		return err
	}

	event := circles.EventPromoted
	if role == circles.RoleMember {
		event = circles.EventDemoted
	}

	// The count follows the role, and a demotion is conditioned on there
	// being another admin — the check in the service reads the roster
	// first, which two demotions at once can both pass.
	now := s.Now()
	meta := "SET " + dynamo.AttrLastEntryAt + " = :now ADD " + dynamo.AttrRosterVersion + " :one"
	values := map[string]types.AttributeValue{":one": dynamoutil.Num(1), ":now": dynamoutil.Millis(now)}
	condition := ""
	switch {
	case role == circles.RoleAdmin && !current.IsAdmin():
		meta += ", " + dynamo.AttrAdminCount + " :one"
	case role == circles.RoleMember && current.IsAdmin():
		meta += ", " + dynamo.AttrAdminCount + " :minusOne"
		values[":minusOne"] = dynamoutil.Num(-1)
		condition = dynamo.AttrAdminCount + " > :one"
	}

	err = dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MemberKey(accountID)),
					UpdateExpression:          aws.String("SET #role = :role"),
					ConditionExpression:       aws.String("attribute_exists(sk)"),
					ExpressionAttributeNames:  map[string]string{"#role": dynamo.AttrRole},
					ExpressionAttributeValues: map[string]types.AttributeValue{":role": dynamoutil.Str(role)},
				}},
				{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
					UpdateExpression:          aws.String(meta),
					ConditionExpression:       optional(condition),
					ExpressionAttributeValues: values,
				}},
				{Put: &types.Put{
					TableName: aws.String(s.Name),
					Item: dynamo.ActivityItem(circleID, circles.Entry{
						Type:        circles.TypeActivity,
						Event:       event,
						AuthorID:    actorID,
						SubjectID:   accountID,
						SubjectName: subjectName,
						ReceivedAt:  s.Now(),
					}),
				}},
			},
		})
		return err
	})
	switch {
	case dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed:
		return circles.ErrNotMember
	case dynamoutil.CancelledFor(err, 1) == dynamoutil.ConditionalCheckFailed:
		return circles.ErrWouldEmptyAdmins
	}
	return err
}

// SetNotifyLevel is the one membership field its owner changes, and the
// only one that writes no activity: nobody else needs to know.
// SetAvatar records which picture this member put in this circle, and
// the key version it was sealed under. The roster version moves so the
// member's other devices and everyone else refetch.
func (s *Store) SetAvatar(ctx context.Context, circleID, accountID, avatarID string, keyVersion int64) error {
	err := dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Update: &types.Update{
					TableName: aws.String(s.Name),
					Key:       s.Key(dynamo.CirclePK(circleID), dynamo.MemberKey(accountID)),
					UpdateExpression: aws.String("SET " + dynamo.AttrAvatarID + " = :avatar, " +
						dynamo.AttrAvatarVersion + " = :version"),
					ConditionExpression: aws.String("attribute_exists(sk)"),
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":avatar":  dynamoutil.Str(avatarID),
						":version": dynamoutil.Num(keyVersion),
					},
				}},
				{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
					UpdateExpression:          aws.String("ADD " + dynamo.AttrRosterVersion + " :one"),
					ExpressionAttributeValues: map[string]types.AttributeValue{":one": dynamoutil.Num(1)},
				}},
			},
		})
		return err
	})
	if dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed {
		return circles.ErrNotMember
	}
	return err
}

func (s *Store) SetNotifyLevel(ctx context.Context, circleID, accountID, level string) error {
	err := dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MemberKey(accountID)),
					UpdateExpression:          aws.String("SET " + dynamo.AttrNotifyLevel + " = :level"),
					ConditionExpression:       aws.String("attribute_exists(sk)"),
					ExpressionAttributeValues: map[string]types.AttributeValue{":level": dynamoutil.Str(level)},
				}},
				// No activity row — nobody else needs to know — but the
				// version moves, so this account's other devices refetch.
				{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
					UpdateExpression:          aws.String("ADD " + dynamo.AttrRosterVersion + " :one"),
					ExpressionAttributeValues: map[string]types.AttributeValue{":one": dynamoutil.Num(1)},
				}},
			},
		})
		return err
	})
	if dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed {
		return circles.ErrNotMember
	}
	return err
}

// Remove takes a member out and installs the next content key in the
// same transaction: the removed member is gone and everyone else can
// read forward, or neither happened.
//
// sealed must hold the new key for exactly the members who remain. The
// check is not a formality — a missing entry would leave someone in the
// circle unable to read anything posted after this.
func (s *Store) RemoveMember(ctx context.Context, circleID, accountID, actorID, subjectName string, expectedVersion int64, sealed map[string][]byte) error {
	roster, err := s.ListMembers(ctx, circleID)
	if err != nil {
		return err
	}

	survivors := make([]circles.Member, 0, len(roster))
	found := false
	for _, member := range roster {
		if member.AccountID == accountID {
			found = true
			continue
		}
		survivors = append(survivors, member)
	}
	if !found {
		return circles.ErrNotMember
	}
	if len(sealed) != len(survivors) {
		return circles.ErrIncompleteKeys
	}
	for _, member := range survivors {
		if len(sealed[member.AccountID]) == 0 {
			return circles.ErrIncompleteKeys
		}
	}

	var removed circles.Member
	for _, member := range roster {
		if member.AccountID == accountID {
			removed = member
		}
	}
	adminDelta := ""
	if removed.IsAdmin() {
		adminDelta = ", " + dynamo.AttrAdminCount + " :minusOne"
	}

	version := strconv.FormatInt(expectedVersion+1, 10)
	items := []types.TransactWriteItem{
		{Delete: &types.Delete{
			TableName:           aws.String(s.Name),
			Key:                 s.Key(dynamo.CirclePK(circleID), dynamo.MemberKey(accountID)),
			ConditionExpression: aws.String("attribute_exists(sk)"),
		}},
		// Their sealed copies go with them. They already hold the keys up
		// to this version on their device, so this is tidiness rather
		// than a lock — the rotation is what actually shuts them out.
		{Delete: &types.Delete{
			TableName: aws.String(s.Name),
			Key:       s.Key(dynamo.CirclePK(circleID), dynamo.SealedKeyKey(accountID)),
		}},
		{Update: &types.Update{
			TableName: aws.String(s.Name),
			Key:       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
			UpdateExpression: aws.String(
				"SET " + dynamo.AttrKeyVersion + " = :next ADD " + dynamo.AttrRosterVersion + " :one, " +
					dynamo.AttrMemberCount + " :minusOne" + adminDelta,
			),
			ConditionExpression: aws.String(dynamo.AttrKeyVersion + " = :expected"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":next":     dynamoutil.Num(expectedVersion + 1),
				":expected": dynamoutil.Num(expectedVersion),
				":one":      dynamoutil.Num(1),
				":minusOne": dynamoutil.Num(-1),
			},
		}},
		{Put: &types.Put{
			TableName: aws.String(s.Name),
			Item: dynamo.ActivityItem(circleID, circles.Entry{
				Type:        circles.TypeActivity,
				Event:       circles.EventRemoved,
				AuthorID:    actorID,
				SubjectID:   accountID,
				SubjectName: subjectName,
				ReceivedAt:  s.Now(),
			}),
		}},
	}
	for _, member := range survivors {
		items = append(items, types.TransactWriteItem{Update: &types.Update{
			TableName:        aws.String(s.Name),
			Key:              s.Key(dynamo.CirclePK(circleID), dynamo.SealedKeyKey(member.AccountID)),
			UpdateExpression: aws.String("SET #keys.#version = :sealed, " + dynamo.AttrUpdatedAt + " = :now"),
			ExpressionAttributeNames: map[string]string{
				"#keys":    dynamo.AttrKeys,
				"#version": version,
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":sealed": dynamoutil.Binary(sealed[member.AccountID]),
				":now":    dynamoutil.Millis(s.Now()),
			},
		}})
	}

	err = dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
		return err
	})
	switch {
	case dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed:
		return circles.ErrNotMember
	case dynamoutil.CancelledFor(err, 2) == dynamoutil.ConditionalCheckFailed:
		// Another admin rotated first, so these sealed keys are for a
		// version that is already history.
		return circles.ErrVersionMoved
	}
	return err
}

// Leave is a member removing themselves, installing the next content
// key in the same transaction — the same way Remove does, so a roster
// change means the same thing to reason about whether the circle pushed
// someone out or they walked.
//
// sealed must hold the new key for exactly the members who remain, same
// as Remove. The last admin still cannot leave while anyone else does:
// checked atomically here, since the service's own check reads the
// roster first, which two departures at once can both pass.
func (s *Store) LeaveCircle(ctx context.Context, circleID, accountID, subjectName string, expectedVersion int64, sealed map[string][]byte) error {
	roster, err := s.ListMembers(ctx, circleID)
	if err != nil {
		return err
	}

	survivors := make([]circles.Member, 0, len(roster))
	var leaving circles.Member
	found := false
	for _, member := range roster {
		if member.AccountID == accountID {
			found, leaving = true, member
			continue
		}
		survivors = append(survivors, member)
	}
	if !found {
		return circles.ErrNotMember
	}
	if len(sealed) != len(survivors) {
		return circles.ErrIncompleteKeys
	}
	for _, member := range survivors {
		if len(sealed[member.AccountID]) == 0 {
			return circles.ErrIncompleteKeys
		}
	}

	now := s.Now()
	meta := "SET " + dynamo.AttrLastEntryAt + " = :now, " + dynamo.AttrKeyVersion + " = :next ADD " +
		dynamo.AttrRosterVersion + " :one, " + dynamo.AttrMemberCount + " :minusOne"
	values := map[string]types.AttributeValue{
		":one": dynamoutil.Num(1), ":minusOne": dynamoutil.Num(-1), ":now": dynamoutil.Millis(now),
		":next": dynamoutil.Num(expectedVersion + 1), ":expected": dynamoutil.Num(expectedVersion),
	}
	condition := dynamo.AttrKeyVersion + " = :expected"
	if leaving.IsAdmin() {
		meta += ", " + dynamo.AttrAdminCount + " :minusOne"
		// Another admin has to remain — unless nobody does, since the
		// last member out strands nobody.
		condition += " AND (" + dynamo.AttrAdminCount + " > :one OR " + dynamo.AttrMemberCount + " = :one)"
	}

	version := strconv.FormatInt(expectedVersion+1, 10)
	items := []types.TransactWriteItem{
		{Delete: &types.Delete{
			TableName:           aws.String(s.Name),
			Key:                 s.Key(dynamo.CirclePK(circleID), dynamo.MemberKey(accountID)),
			ConditionExpression: aws.String("attribute_exists(sk)"),
		}},
		{Delete: &types.Delete{
			TableName: aws.String(s.Name),
			Key:       s.Key(dynamo.CirclePK(circleID), dynamo.SealedKeyKey(accountID)),
		}},
		{Update: &types.Update{
			TableName:                 aws.String(s.Name),
			Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
			UpdateExpression:          aws.String(meta),
			ConditionExpression:       aws.String(condition),
			ExpressionAttributeValues: values,
		}},
		{Put: &types.Put{
			TableName: aws.String(s.Name),
			Item: dynamo.ActivityItem(circleID, circles.Entry{
				Type:        circles.TypeActivity,
				Event:       circles.EventLeft,
				AuthorID:    accountID,
				SubjectID:   accountID,
				SubjectName: subjectName,
				ReceivedAt:  s.Now(),
			}),
		}},
	}
	for _, member := range survivors {
		items = append(items, types.TransactWriteItem{Update: &types.Update{
			TableName:        aws.String(s.Name),
			Key:              s.Key(dynamo.CirclePK(circleID), dynamo.SealedKeyKey(member.AccountID)),
			UpdateExpression: aws.String("SET #keys.#version = :sealed, " + dynamo.AttrUpdatedAt + " = :now"),
			ExpressionAttributeNames: map[string]string{
				"#keys":    dynamo.AttrKeys,
				"#version": version,
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":sealed": dynamoutil.Binary(sealed[member.AccountID]),
				":now":    dynamoutil.Millis(s.Now()),
			},
		}})
	}

	err = dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
		return err
	})
	switch {
	case dynamoutil.CancelledFor(err, 0) == dynamoutil.ConditionalCheckFailed:
		return circles.ErrNotMember
	case dynamoutil.CancelledFor(err, 2) == dynamoutil.ConditionalCheckFailed:
		return s.leaveConflict(ctx, circleID, expectedVersion)
	}
	return err
}

// leaveConflict tells a lost race from a stranding: the meta row's
// condition ANDs both, so a cancelled write doesn't say by itself which
// one failed. A plain read after the fact is fine here — the write has
// already lost, so there is no freshness to protect.
func (s *Store) leaveConflict(ctx context.Context, circleID string, expectedVersion int64) error {
	current, err := s.GetCircle(ctx, circleID)
	if err != nil {
		return err
	}
	if current.KeyVersion != expectedVersion {
		return circles.ErrVersionMoved
	}
	return circles.ErrWouldEmptyAdmins
}

// Rewrap replaces one member's sealed keys with copies under their new
// public key, and clears the flag that asked for them.
func (s *Store) ReplaceSealedKeys(ctx context.Context, circleID, accountID string, sealed circles.SealedKeys) error {
	err := dynamo.WithRetry(func() error {
		_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{Put: &types.Put{
					TableName: aws.String(s.Name),
					Item: map[string]types.AttributeValue{
						dynamoutil.PKAttr:    dynamoutil.Str(dynamo.CirclePK(circleID)),
						dynamoutil.SKAttr:    dynamoutil.Str(dynamo.SealedKeyKey(accountID)),
						dynamo.AttrKeys:      dynamo.SealedKeysAttr(sealed),
						dynamo.AttrUpdatedAt: dynamoutil.Millis(s.Now()),
					},
				}},
				{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MemberKey(accountID)),
					UpdateExpression:          aws.String("SET " + dynamo.AttrNeedsRewrap + " = :no"),
					ConditionExpression:       aws.String("attribute_exists(sk)"),
					ExpressionAttributeValues: map[string]types.AttributeValue{":no": dynamoutil.Bool(false)},
				}},
				// The circle's own version, not the member row's: it is what
				// every other device watches to know the keys moved.
				{Update: &types.Update{
					TableName:                 aws.String(s.Name),
					Key:                       s.Key(dynamo.CirclePK(circleID), dynamo.MetaSK),
					UpdateExpression:          aws.String("ADD " + dynamo.AttrRosterVersion + " :one"),
					ExpressionAttributeValues: map[string]types.AttributeValue{":one": dynamoutil.Num(1)},
				}},
			},
		})
		return err
	})
	if dynamoutil.CancelledFor(err, 1) == dynamoutil.ConditionalCheckFailed {
		return circles.ErrNotMember
	}
	return err
}

// MarkNeedsRewrap flags every membership this account holds, after it
// replaced its keypair: its stored keys are sealed to a public key it no
// longer has. Returns the circles that need someone to reseal.
func (s *Store) MarkMembershipsNeedRewrap(ctx context.Context, accountID string) ([]string, error) {
	memberships, err := s.ListMemberships(ctx, accountID)
	if err != nil {
		return nil, err
	}

	circleIDs := make([]string, 0, len(memberships))
	for _, membership := range memberships {
		err := dynamo.WithRetry(func() error {
			_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
				TransactItems: []types.TransactWriteItem{
					{Update: &types.Update{
						TableName:                 aws.String(s.Name),
						Key:                       s.Key(dynamo.CirclePK(membership.Circle.ID), dynamo.MemberKey(accountID)),
						UpdateExpression:          aws.String("SET " + dynamo.AttrNeedsRewrap + " = :yes"),
						ConditionExpression:       aws.String("attribute_exists(sk)"),
						ExpressionAttributeValues: map[string]types.AttributeValue{":yes": dynamoutil.Bool(true)},
					}},
					{Update: &types.Update{
						TableName:                 aws.String(s.Name),
						Key:                       s.Key(dynamo.CirclePK(membership.Circle.ID), dynamo.MetaSK),
						UpdateExpression:          aws.String("ADD " + dynamo.AttrRosterVersion + " :one"),
						ExpressionAttributeValues: map[string]types.AttributeValue{":one": dynamoutil.Num(1)},
					}},
				},
			})
			return err
		})
		if err != nil {
			return nil, err
		}
		circleIDs = append(circleIDs, membership.Circle.ID)
	}
	return circleIDs, nil
}

// optional turns an empty condition into none at all: DynamoDB rejects
// an empty ConditionExpression, and several writes here only carry one
// in some cases.
func optional(condition string) *string {
	if condition == "" {
		return nil
	}
	return aws.String(condition)
}
