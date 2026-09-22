package dynamo_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/util/testsupport"
)

// The whole point of an internal account id: a sign-in is a lookup onto
// it, so the same person coming back lands on the account they left.
func TestResolve_TheSameSignInIsTheSameAccount(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	subject := testsupport.UniqueAccountID(t)

	first, created, err := table.Resolve(ctx, accounts.Provider{Name: "google", Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("expected the first sign-in to mint an account")
	}

	again, created, err := table.Resolve(ctx, accounts.Provider{Name: "google", Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Error("expected a returning sign-in to find the account, not mint one")
	}
	if again != first {
		t.Fatalf("expected the same account, got %q and %q", first, again)
	}
}

// Google's and Apple's subjects come from unrelated id spaces, so the
// same string from each must not collide into one account.
func TestResolve_TheSameSubjectFromTwoProvidersIsTwoAccounts(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	subject := testsupport.UniqueAccountID(t)

	google, _, err := table.Resolve(ctx, accounts.Provider{Name: "google", Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	apple, _, err := table.Resolve(ctx, accounts.Provider{Name: "apple", Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	if google == apple {
		t.Fatalf("expected two accounts, got %q twice", google)
	}
}

// Two devices signing in for the first time at once: the lookup row is
// conditional, so one mints and the other reads what it minted. Two
// accounts here would split one person in half, each holding different
// circles.
func TestResolve_ARaceOnAFirstSignInMintsOneAccount(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	subject := testsupport.UniqueAccountID(t)

	const racers = 6
	ids := make([]string, racers)
	mints := make([]bool, racers)
	errs := make([]error, racers)
	var wg sync.WaitGroup
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ids[i], mints[i], errs[i] = table.Resolve(ctx, accounts.Provider{Name: "google", Subject: subject})
		}()
	}
	wg.Wait()

	minted := 0
	for i := range racers {
		if errs[i] != nil {
			t.Fatalf("racer %d failed: %v", i, errs[i])
		}
		if ids[i] == "" {
			t.Fatalf("racer %d resolved to no account", i)
		}
		if ids[i] != ids[0] {
			t.Fatalf("expected one account, got %q and %q", ids[0], ids[i])
		}
		if mints[i] {
			minted++
		}
	}
	if minted != 1 {
		t.Errorf("expected exactly one sign-in to report minting, got %d", minted)
	}
}

// What deletion reads to know which grant to revoke, and which lookup
// rows to remove.
func TestProviders_ListsTheSignInsThatResolveHere(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	subject := testsupport.UniqueAccountID(t)

	accountID, _, err := table.Resolve(ctx, accounts.Provider{Name: "apple", Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	if err := table.SaveRefreshToken(ctx, accountID, "apple", subject, "r-123"); err != nil {
		t.Fatal(err)
	}

	providers, err := table.Providers(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 {
		t.Fatalf("expected one sign-in, got %d", len(providers))
	}
	got := providers[0]
	if got.Name != "apple" || got.Subject != subject {
		t.Fatalf("expected the sign-in back as it was linked, got %+v", got)
	}
	if got.RefreshToken != "r-123" {
		t.Errorf("expected the banked grant, got %q", got.RefreshToken)
	}
	if got.LinkedAt.IsZero() {
		t.Error("expected a stamp saying when the sign-in was linked")
	}
}

// A subject with a colon in it still splits back into the provider it
// came from and the subject itself, since the row name joins them with
// one.
func TestProviders_ASubjectHoldingAColon(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)
	subject := testsupport.UniqueAccountID(t) + ":with:colons"

	accountID, _, err := table.Resolve(ctx, accounts.Provider{Name: "google", Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	providers, err := table.Providers(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].Name != "google" || providers[0].Subject != subject {
		t.Fatalf("expected the subject back whole, got %+v", providers)
	}
}

// Banking a grant against a sign-in that was never linked would leave a
// token nothing can spend.
func TestSaveRefreshToken_WithoutTheSignIn(t *testing.T) {
	ctx := context.Background()
	table := testsupport.NewAccountTable(t)

	err := table.SaveRefreshToken(ctx, testsupport.UniqueAccountID(t), "apple", "never-linked", "r-123")
	if !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}
