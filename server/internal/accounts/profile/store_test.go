package profile_test

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/accounts/profile"
	"mimoza-relay/internal/util/testsupport"
)

// newAccount mints one the way a sign-in does, which is the only way a
// profile row comes to exist.
func newAccount(t *testing.T, table *dynamo.Table) string {
	t.Helper()
	accountID, created, err := table.Resolve(context.Background(), accounts.Provider{
		Name: "testonly", Subject: testsupport.UniqueAccountID(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("expected a fresh account")
	}
	return accountID
}

func TestStore_AProfileIsWrittenAndReadBack(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := profile.NewStore(table)
	accountID := newAccount(t, table)

	// A new account has a row, an id and a creation stamp, and nothing
	// else: the name comes from a screen the person has not seen yet.
	fresh, err := store.GetProfile(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Name != "" || len(fresh.PublicKey) != 0 {
		t.Fatalf("expected an empty profile, got %+v", fresh)
	}
	if fresh.CreatedAt.IsZero() {
		t.Error("expected a creation stamp")
	}

	if err := store.SetProfile(ctx, accountID, "Sarah", "avatars/sarah"); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetProfile(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Sarah" || got.AvatarKey != "avatars/sarah" {
		t.Fatalf("expected the written profile back, got %+v", got)
	}
	if !got.CreatedAt.Equal(fresh.CreatedAt) {
		t.Error("writing a name must not restamp the account")
	}
}

// Every write is conditioned on the account existing, so a session that
// outlived its account writes nothing rather than resurrecting it as a
// bare profile row.
func TestStore_WritingToAnAccountThatIsGone(t *testing.T) {
	ctx := context.Background()
	store := profile.NewStore(testsupport.NewAccountTable(t))
	missing := testsupport.UniqueAccountID(t)

	if err := store.SetProfile(ctx, missing, "Sarah", ""); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := store.SetPublicKey(ctx, missing, []byte("key")); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if _, err := store.GetProfile(ctx, missing); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// Replacing the key is the recovery path: the new one is what members
// seal to from then on, and the stamp says when it changed.
func TestStore_ThePublicKeyIsReplacedWholesale(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	store := profile.NewStore(table)
	accountID := newAccount(t, table)

	if err := store.SetPublicKey(ctx, accountID, []byte("first-key")); err != nil {
		t.Fatal(err)
	}
	first, err := store.GetProfile(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.PublicKey, []byte("first-key")) {
		t.Fatalf("expected the first key, got %q", first.PublicKey)
	}
	if first.PublicKeySetAt.IsZero() {
		t.Error("expected a stamp saying when the key was published")
	}

	if err := store.SetPublicKey(ctx, accountID, []byte("second-key")); err != nil {
		t.Fatal(err)
	}
	second, err := store.GetProfile(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(second.PublicKey, []byte("second-key")) {
		t.Fatalf("expected the replacement, got %q", second.PublicKey)
	}
	// The name is on the same row as the key and must survive a reset —
	// a recovering device is still the same person.
	if err := store.SetProfile(ctx, accountID, "Sarah", ""); err != nil {
		t.Fatal(err)
	}
	after, err := store.GetProfile(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Name != "Sarah" || !bytes.Equal(after.PublicKey, []byte("second-key")) {
		t.Fatalf("expected the name and the key to share the row, got %+v", after)
	}
}
