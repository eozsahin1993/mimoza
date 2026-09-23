package deletion_test

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/accounts/deletion"
	"mimoza-relay/internal/accounts/devices"
	"mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/accounts/profile"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/util/testsupport"
)

// Deleting an account leaves nothing behind: not the profile, not the
// phones push would have reached, and not the sign-in that resolved to
// it — which is what makes the next sign-in a new person rather than a
// half-deleted one.
func TestStore_DeleteLeavesNothingBehind(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := deletion.NewStore(table)
	subject := testsupport.UniqueAccountID(t)

	accountID, _, err := table.Resolve(ctx, accounts.Provider{Name: "google", Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	if err := profile.NewStore(table).SetProfile(ctx, accountID, "Sarah"); err != nil {
		t.Fatal(err)
	}
	if err := devices.NewStore(table).PutDevice(ctx, accountID, accounts.Device{
		DeviceID: "phone-1", PushToken: "token-1", Platform: accounts.PlatformIOS,
	}); err != nil {
		t.Fatal(err)
	}

	if err := store.Delete(ctx, accountID, ""); err != nil {
		t.Fatal(err)
	}

	if _, err := table.GetProfile(ctx, accountID); !errors.Is(err, accounts.ErrNotFound) {
		t.Errorf("expected the profile to be gone, got %v", err)
	}
	phones, err := table.ListDevices(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(phones) != 0 {
		t.Errorf("expected no phones left, got %+v", phones)
	}
	providers, err := table.Providers(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 0 {
		t.Errorf("expected no sign-ins left, got %+v", providers)
	}

	// The lookup row went too, so signing in again is a fresh account
	// rather than a session onto a partition with nothing in it.
	next, created, err := table.Resolve(ctx, accounts.Provider{Name: "google", Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	if !created || next == accountID {
		t.Fatalf("expected a new account after deletion, got %q (created=%v)", next, created)
	}
}

// A grant that could not be revoked stays behind, but the sign-in it
// belonged to does not: the credential is there for a later retry without
// the deleted account still being reachable.
func TestStore_DeleteKeepsAnUnrevokedGrant(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := deletion.NewStore(table)
	subject := testsupport.UniqueAccountID(t)

	accountID, _, err := table.Resolve(ctx, accounts.Provider{Name: auth.AppleProvider, Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	if err := table.SaveRefreshToken(ctx, accountID, auth.AppleProvider, subject, "r-123"); err != nil {
		t.Fatal(err)
	}
	if err := profile.NewStore(table).SetProfile(ctx, accountID, "Sarah"); err != nil {
		t.Fatal(err)
	}

	if err := store.Delete(ctx, accountID, dynamo.ProviderKey(auth.AppleProvider, subject)); err != nil {
		t.Fatal(err)
	}

	providers, err := table.Providers(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].RefreshToken != "r-123" {
		t.Fatalf("expected the unspent grant to survive, got %+v", providers)
	}
	if _, err := table.GetProfile(ctx, accountID); !errors.Is(err, accounts.ErrNotFound) {
		t.Errorf("expected the profile to be gone, got %v", err)
	}

	next, created, err := table.Resolve(ctx, accounts.Provider{Name: auth.AppleProvider, Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	if !created || next == accountID {
		t.Fatalf("expected the sign-in to land on a new account, got %q (created=%v)", next, created)
	}
}

// A deletion interrupted between the lookup row and the provider row
// leaves the subject free to sign in again. The retry still walks the
// stale provider row, and must not take the new account's lookup with
// it — that account is live, and would lose its sign-in.
func TestStore_DeleteRetryLeavesANewAccountAlone(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := deletion.NewStore(table)
	subject := testsupport.UniqueAccountID(t)
	signIn := accounts.Provider{Name: "google", Subject: subject}

	old, _, err := table.Resolve(ctx, signIn)
	if err != nil {
		t.Fatal(err)
	}

	// Where an interrupted deletion leaves things: the lookup gone, the
	// provider row under the old account still there.
	if _, err := table.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(table.Name),
		Key:       table.Key(dynamo.ProviderPK(signIn.Name, signIn.Subject), dynamo.LookupSK),
	}); err != nil {
		t.Fatal(err)
	}

	fresh, created, err := table.Resolve(ctx, signIn)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatalf("expected the sign-in to mint a new account, got %q", fresh)
	}

	if err := store.Delete(ctx, old, ""); err != nil {
		t.Fatal(err)
	}

	again, created, err := table.Resolve(ctx, signIn)
	if err != nil {
		t.Fatal(err)
	}
	if created || again != fresh {
		t.Fatalf("expected the new account %q to keep its sign-in, got %q (created=%v)", fresh, again, created)
	}
}

// A retry finds nothing left and says so by doing nothing: deletion can
// be interrupted anywhere, and the client repeats it.
func TestStore_DeletingTwiceIsNotAnError(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := deletion.NewStore(table)

	accountID, _, err := table.Resolve(ctx, accounts.Provider{
		Name: "google", Subject: testsupport.UniqueAccountID(t),
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Delete(ctx, accountID, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(ctx, accountID, ""); err != nil {
		t.Fatalf("a repeated deletion must be a no-op, got %v", err)
	}
	if err := store.Delete(ctx, testsupport.UniqueAccountID(t), ""); err != nil {
		t.Fatalf("deleting an account that never existed must be a no-op, got %v", err)
	}
}

// One account's deletion must not reach another's rows — they share the
// table, and only the partition keeps them apart.
func TestStore_DeleteTouchesOnlyThatAccount(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := deletion.NewStore(table)

	mine, _, err := table.Resolve(ctx, accounts.Provider{Name: "google", Subject: testsupport.UniqueAccountID(t)})
	if err != nil {
		t.Fatal(err)
	}
	theirs, _, err := table.Resolve(ctx, accounts.Provider{Name: "google", Subject: testsupport.UniqueAccountID(t)})
	if err != nil {
		t.Fatal(err)
	}
	if err := profile.NewStore(table).SetProfile(ctx, theirs, "Ali"); err != nil {
		t.Fatal(err)
	}

	if err := store.Delete(ctx, mine, ""); err != nil {
		t.Fatal(err)
	}

	got, err := table.GetProfile(ctx, theirs)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Ali" {
		t.Fatalf("expected the other account untouched, got %+v", got)
	}
}
