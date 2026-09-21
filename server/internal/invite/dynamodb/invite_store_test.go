package dynamodb_test

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/invite"
	"mimoza-relay/internal/util/testsupport"
)

func getRawItem(t *testing.T, client *awsdynamodb.Client, table, pk, sk string) map[string]types.AttributeValue {
	t.Helper()
	out, err := client.GetItem(context.Background(), &awsdynamodb.GetItemInput{
		TableName: aws.String(table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: pk},
			"sk": &types.AttributeValueMemberS{Value: sk},
		},
	})
	if err != nil {
		t.Fatalf("failed to read raw item: %v", err)
	}
	if out.Item == nil {
		t.Fatalf("expected item at pk=%s sk=%s to exist", pk, sk)
	}
	return out.Item
}

func mustAttrInt(t *testing.T, item map[string]types.AttributeValue, key string) int64 {
	t.Helper()
	attr, ok := item[key]
	if !ok {
		t.Fatalf("missing attribute %q", key)
	}
	n, ok := attr.(*types.AttributeValueMemberN)
	if !ok {
		t.Fatalf("attribute %q is not a number", key)
	}
	value, err := strconv.ParseInt(n.Value, 10, 64)
	if err != nil {
		t.Fatalf("attribute %q is not a valid integer: %v", key, err)
	}
	return value
}

func TestInviteStore_CreateInviteThenGetInvite_RoundTrips(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)
	inviteTag := testsupport.UniqueInviteTag(t)
	preview := []byte("pretend-encrypted-preview")

	if err := store.CreateInvite(ctx, inviteTag, preview); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetInvite(ctx, inviteTag)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(preview) {
		t.Fatalf("expected %q, got %q", preview, got)
	}
}

// Anyone holding the code can compute the tag, so a second write must not
// replace the creator's preview.
func TestInviteStore_CreateInvite_RefusesToOverwrite(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)
	inviteTag := testsupport.UniqueInviteTag(t)

	if err := store.CreateInvite(ctx, inviteTag, []byte("creator-preview")); err != nil {
		t.Fatal(err)
	}
	err := store.CreateInvite(ctx, inviteTag, []byte("forged-preview"))
	if !errors.Is(err, invite.ErrInviteExists) {
		t.Fatalf("expected ErrInviteExists, got %v", err)
	}

	got, err := store.GetInvite(ctx, inviteTag)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "creator-preview" {
		t.Fatalf("expected the creator's preview to survive, got %q", got)
	}
}

func TestInviteStore_GetInvite_ReturnsNilForAnUnknownTag(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)

	got, err := store.GetInvite(ctx, testsupport.UniqueInviteTag(t))
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %q", got)
	}
}

func TestInviteStore_CreateInvite_WritesExpiresAtFromRetentionWindow(t *testing.T) {
	ctx := context.Background()
	inviteTag := testsupport.UniqueInviteTag(t)
	const retentionDays = 3
	store := testsupport.NewInviteStore(t, retentionDays)
	client, table := testsupport.RawInviteDynamoDBClient(t)

	before := time.Now().Unix()
	if err := store.CreateInvite(ctx, inviteTag, []byte("preview")); err != nil {
		t.Fatal(err)
	}
	after := time.Now().Unix()

	item := getRawItem(t, client, table, inviteTag, "invite")
	expiresAt := mustAttrInt(t, item, "expiresAt")
	wantMin := before + retentionDays*24*60*60
	wantMax := after + retentionDays*24*60*60
	if expiresAt < wantMin || expiresAt > wantMax {
		t.Fatalf("expiresAt = %d, want between %d and %d", expiresAt, wantMin, wantMax)
	}
}

func TestInviteStore_PutJoinRequestThenGetJoinRequest_RoundTrips(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)
	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"
	encryptedRequest := []byte("pretend-encrypted-join-request")

	if err := store.PutJoinRequest(ctx, inviteTag, requesterID, encryptedRequest); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetJoinRequest(ctx, inviteTag, requesterID)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected a non-nil join request")
	}
	if got.RequesterID != requesterID || string(got.EncryptedRequest) != string(encryptedRequest) {
		t.Fatalf("unexpected join request: %+v", got)
	}
	if got.EncryptedApproval != nil {
		t.Fatalf("expected no approval yet, got %q", got.EncryptedApproval)
	}
}

func TestInviteStore_GetJoinRequest_ReturnsNilForAnUnknownRequester(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)

	got, err := store.GetJoinRequest(ctx, testsupport.UniqueInviteTag(t), "nobody")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

// TestInviteStore_PutJoinRequest_DuplicateIsIdempotent matches the
// create-if-not-exists contract documented on invite.Store —
// PutJoinRequest.
func TestInviteStore_PutJoinRequest_DuplicateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)
	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"

	if err := store.PutJoinRequest(ctx, inviteTag, requesterID, []byte("first")); err != nil {
		t.Fatal(err)
	}
	// A second write for the same (inviteTag, requesterID), as a retry
	// would send, must succeed rather than erroring on the condition check.
	if err := store.PutJoinRequest(ctx, inviteTag, requesterID, []byte("first")); err != nil {
		t.Fatalf("expected duplicate PutJoinRequest to succeed idempotently, got %v", err)
	}

	got, err := store.GetJoinRequest(ctx, inviteTag, requesterID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.EncryptedRequest) != "first" {
		t.Fatalf("expected the original write to survive, got %q", got.EncryptedRequest)
	}
}

func TestInviteStore_ListJoinRequests_ReturnsOnlyRequestsUnderThatTag(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)
	inviteTag := testsupport.UniqueInviteTag(t)
	otherTag := testsupport.UniqueInviteTag(t)

	if err := store.PutJoinRequest(ctx, inviteTag, "requester-a", []byte("a")); err != nil {
		t.Fatal(err)
	}
	if err := store.PutJoinRequest(ctx, inviteTag, "requester-b", []byte("b")); err != nil {
		t.Fatal(err)
	}
	if err := store.PutJoinRequest(ctx, otherTag, "requester-c", []byte("c")); err != nil {
		t.Fatal(err)
	}
	// The invite row itself shares the same pk — must not be mistaken for
	// a join request.
	if err := store.CreateInvite(ctx, inviteTag, []byte("preview")); err != nil {
		t.Fatal(err)
	}

	got, err := store.ListJoinRequests(ctx, inviteTag)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 requests, got %d: %+v", len(got), got)
	}
}

func TestInviteStore_ApproveJoinRequestThenGet_ShowsApproval(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)
	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"
	approval := []byte("pretend-sealed-box-approval")

	if err := store.PutJoinRequest(ctx, inviteTag, requesterID, []byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := store.ApproveJoinRequest(ctx, inviteTag, requesterID, approval); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetJoinRequest(ctx, inviteTag, requesterID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.EncryptedApproval) != string(approval) {
		t.Fatalf("expected approval %q, got %q", approval, got.EncryptedApproval)
	}
}

func TestInviteStore_ApproveJoinRequest_ErrorsForANonexistentRequest(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)

	err := store.ApproveJoinRequest(ctx, testsupport.UniqueInviteTag(t), "nobody", []byte("approval"))
	if !errors.Is(err, invite.ErrJoinRequestNotFound) {
		t.Fatalf("expected ErrJoinRequestNotFound, got %v", err)
	}
}

func TestInviteStore_DeleteJoinRequest_RemovesTheRow(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)
	inviteTag := testsupport.UniqueInviteTag(t)
	requesterID := "requester-1"

	if err := store.PutJoinRequest(ctx, inviteTag, requesterID, []byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteJoinRequest(ctx, inviteTag, requesterID); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetJoinRequest(ctx, inviteTag, requesterID)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected the row to be gone after DeleteJoinRequest, got %+v", got)
	}
}

func TestInviteStore_DeleteJoinRequest_IsIdempotentForAnUnknownRequester(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewInviteStore(t, 0)

	if err := store.DeleteJoinRequest(ctx, testsupport.UniqueInviteTag(t), "nobody"); err != nil {
		t.Fatalf("expected deleting a never-existed request to succeed, got %v", err)
	}
}
