package devices_test

import (
	"context"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/accounts/devices"
	"mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/util/testsupport"
)

func newAccount(t *testing.T, table *dynamo.Table) string {
	t.Helper()
	accountID, _, err := table.Resolve(context.Background(), accounts.Provider{
		Name: "testonly", Subject: testsupport.UniqueAccountID(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	return accountID
}

// A push token rotates on its own schedule, so registering the same
// phone again is the ordinary case: one row, the newest token.
func TestStore_RegisteringAPhoneAgainRotatesItsToken(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := devices.NewStore(table)
	accountID := newAccount(t, table)

	first := accounts.Device{DeviceID: "phone-1", PushToken: "token-1", Platform: accounts.PlatformIOS, Locale: "en"}
	if err := store.PutDevice(ctx, accountID, first); err != nil {
		t.Fatal(err)
	}
	if err := store.PutDevice(ctx, accountID, accounts.Device{
		DeviceID: "phone-1", PushToken: "token-2", Platform: accounts.PlatformIOS, Locale: "tr",
	}); err != nil {
		t.Fatal(err)
	}

	list, err := store.ListDevices(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("expected one phone, got %d", len(list))
	}
	if list[0].PushToken != "token-2" || list[0].Locale != "tr" {
		t.Fatalf("expected the rotated token, got %+v", list[0])
	}
	if list[0].DeviceID != "phone-1" {
		t.Errorf("expected the device id to survive the round trip, got %q", list[0].DeviceID)
	}
	if list[0].UpdatedAt.IsZero() {
		t.Error("expected a stamp saying when the token last moved")
	}
}

// Push reaches the devices an account registers and nothing else, so a
// second account's phones must not appear on the first's list.
func TestStore_DevicesBelongToOneAccount(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := devices.NewStore(table)
	mine, theirs := newAccount(t, table), newAccount(t, table)

	if err := store.PutDevice(ctx, mine, accounts.Device{DeviceID: "phone-1", PushToken: "mine", Platform: accounts.PlatformIOS}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutDevice(ctx, theirs, accounts.Device{DeviceID: "phone-1", PushToken: "theirs", Platform: accounts.PlatformAndroid}); err != nil {
		t.Fatal(err)
	}

	list, err := store.ListDevices(ctx, mine)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].PushToken != "mine" {
		t.Fatalf("expected only this account's phone, got %+v", list)
	}
}

// Signing out takes the phone off and leaves the account alone. Doing it
// twice is not an error: a retried sign-out is the same outcome.
func TestStore_SigningOutRemovesOnlyThatPhone(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := devices.NewStore(table)
	accountID := newAccount(t, table)

	for _, id := range []string{"phone-1", "phone-2"} {
		if err := store.PutDevice(ctx, accountID, accounts.Device{
			DeviceID: id, PushToken: "token-" + id, Platform: accounts.PlatformIOS,
		}); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.DeleteDevice(ctx, accountID, "phone-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDevice(ctx, accountID, "phone-1"); err != nil {
		t.Fatalf("a repeated sign-out must be a no-op, got %v", err)
	}

	list, err := store.ListDevices(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].DeviceID != "phone-2" {
		t.Fatalf("expected the other phone to survive, got %+v", list)
	}
	if _, err := store.GetProfile(ctx, accountID); err != nil {
		t.Errorf("the account itself must be untouched: %v", err)
	}
}
