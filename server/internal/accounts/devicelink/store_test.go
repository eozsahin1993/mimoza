package devicelink_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/accounts/devicelink"
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

func openLink(t *testing.T, store *devicelink.Store, accountID string, expiresIn time.Duration) accounts.DeviceLink {
	t.Helper()
	now := time.Now()
	link := accounts.DeviceLink{
		SessionID: "session-" + accountID,
		PublicKey: bytes.Repeat([]byte{7}, accounts.X25519KeyLength),
		CreatedAt: now,
		ExpiresAt: now.Add(expiresIn),
	}
	if err := store.PutLink(context.Background(), accountID, link); err != nil {
		t.Fatal(err)
	}
	return link
}

func TestStore_ARoundTripCarriesTheSealedKeypair(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := devicelink.NewStore(table)
	accountID := newAccount(t, table)
	link := openLink(t, store, accountID, time.Minute)

	// Before the other device answers, the session is there and empty.
	found, err := store.GetLink(ctx, accountID, link.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if found.Delivered() {
		t.Error("a session nobody has answered should not report a sealed keypair")
	}
	if !bytes.Equal(found.PublicKey, link.PublicKey) {
		t.Errorf("public key came back as %x, want %x", found.PublicKey, link.PublicKey)
	}

	sealed := []byte("sealed-keypair")
	if err := store.SaveSealedKeypair(ctx, accountID, link.SessionID, sealed); err != nil {
		t.Fatal(err)
	}

	found, err = store.GetLink(ctx, accountID, link.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(found.SealedKeypair, sealed) {
		t.Errorf("sealed keypair came back as %q, want %q", found.SealedKeypair, sealed)
	}
	if found.DeliveredAt.IsZero() {
		t.Error("a delivered session should carry when it was answered")
	}
}

// First answer wins. Without this a second device could overwrite the
// blob and decide what the waiting phone ends up holding.
func TestStore_ASecondAnswerIsRefused(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := devicelink.NewStore(table)
	accountID := newAccount(t, table)
	link := openLink(t, store, accountID, time.Minute)

	if err := store.SaveSealedKeypair(ctx, accountID, link.SessionID, []byte("first")); err != nil {
		t.Fatal(err)
	}
	err := store.SaveSealedKeypair(ctx, accountID, link.SessionID, []byte("second"))
	if !errors.Is(err, accounts.ErrLinkAnswered) {
		t.Fatalf("expected ErrLinkAnswered, got %v", err)
	}

	found, err := store.GetLink(ctx, accountID, link.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if string(found.SealedKeypair) != "first" {
		t.Errorf("the first answer should have stood, got %q", found.SealedKeypair)
	}
}

func TestStore_AnUnknownSessionIsNotFound(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := devicelink.NewStore(table)
	accountID := newAccount(t, table)

	if _, err := store.GetLink(ctx, accountID, "never-opened"); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	err := store.SaveSealedKeypair(ctx, accountID, "never-opened", []byte("sealed"))
	if !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound on delivery, got %v", err)
	}
}

// TTL sweeps on DynamoDB's own schedule, so the row is still physically
// there the moment it expires. Both paths have to treat it as gone
// themselves, or the collection window becomes "until the sweeper runs".
func TestStore_AnExpiredSessionIsGoneEvenWhileItsRowRemains(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := devicelink.NewStore(table)
	accountID := newAccount(t, table)
	link := openLink(t, store, accountID, -time.Second)

	if _, err := store.GetLink(ctx, accountID, link.SessionID); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected an expired session to read as ErrNotFound, got %v", err)
	}
	err := store.SaveSealedKeypair(ctx, accountID, link.SessionID, []byte("too late"))
	if !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected an expired session to refuse delivery, got %v", err)
	}
}

// The key shape is the access check: a session lives inside its
// account's partition, so another account naming the same session id
// addresses a row that does not exist.
func TestStore_AnotherAccountCannotReachTheSession(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := devicelink.NewStore(table)
	mine := newAccount(t, table)
	theirs := newAccount(t, table)
	link := openLink(t, store, mine, time.Minute)

	if _, err := store.GetLink(ctx, theirs, link.SessionID); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("another account read the session: %v", err)
	}
	err := store.SaveSealedKeypair(ctx, theirs, link.SessionID, []byte("sealed"))
	if !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("another account answered the session: %v", err)
	}
}
