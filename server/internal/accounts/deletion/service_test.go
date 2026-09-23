package deletion

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/accounts/dynamo"
	"mimoza-relay/internal/auth"
	"mimoza-relay/internal/circles/erase"
)

type fakeAuthStore struct{ sessionsDeletedFor []string }

func (s *fakeAuthStore) SaveSession(context.Context, string, auth.Session) error { return nil }
func (s *fakeAuthStore) GetSession(context.Context, string) (*auth.Session, error) {
	return nil, nil
}
func (s *fakeAuthStore) DeleteSession(context.Context, string) error { return nil }
func (s *fakeAuthStore) DeleteAllSessions(_ context.Context, accountID string) error {
	s.sessionsDeletedFor = append(s.sessionsDeletedFor, accountID)
	return nil
}

// fakeAccounts stands in for the accounts column: what deletion reads
// from it is the Apple grant, and what it does to it is remove the
// account outright. An entry in tokens is an Apple sign-in; an empty
// value is one with nothing banked.
type fakeAccounts struct {
	tokens   map[string]string
	getErr   error
	deleted  []string
	kept     []string
	getCalls int
}

func (s *fakeAccounts) Providers(_ context.Context, accountID string) ([]accounts.Provider, error) {
	s.getCalls++
	if s.getErr != nil {
		return nil, s.getErr
	}
	token, ok := s.tokens[accountID]
	if !ok {
		return nil, nil
	}
	return []accounts.Provider{{Name: auth.AppleProvider, Subject: "sub", RefreshToken: token}}, nil
}

func (s *fakeAccounts) GetProfile(_ context.Context, accountID string) (accounts.Profile, error) {
	return accounts.Profile{AccountID: accountID, Name: "Sarah"}, nil
}

func (s *fakeAccounts) Delete(_ context.Context, accountID, keep string) error {
	s.deleted = append(s.deleted, accountID)
	if keep != "" {
		s.kept = append(s.kept, keep)
		return nil
	}
	delete(s.tokens, accountID)
	return nil
}

func newService(credentials *fakeAccounts, revoke func(context.Context, string) error) (*Service, *fakeAuthStore) {
	sessions := &fakeAuthStore{}
	return &Service{AuthStore: sessions, Store: credentials, RevokeApple: revoke}, sessions
}

// The Guideline 5.1.1(v) path: deleting an Apple account spends the
// banked refresh token, then drops it.
func TestDeleteRevokesTheAppleGrant(t *testing.T) {
	credentials := &fakeAccounts{tokens: map[string]string{"account-1": "r-123"}}
	var revoked []string
	service, sessions := newService(credentials, func(_ context.Context, token string) error {
		revoked = append(revoked, token)
		return nil
	})

	if err := service.Delete(context.Background(), "account-1"); err != nil {
		t.Fatal(err)
	}

	if len(revoked) != 1 || revoked[0] != "r-123" {
		t.Fatalf("expected the stored refresh token to be revoked, got %v", revoked)
	}
	if len(credentials.deleted) != 1 {
		t.Errorf("expected the account itself to be deleted, got %v", credentials.deleted)
	}
	if len(credentials.kept) != 0 {
		t.Errorf("expected a spent grant to go with the account, got %v", credentials.kept)
	}
	if len(sessions.sessionsDeletedFor) != 1 {
		t.Errorf("expected the sessions to be deleted too")
	}
}

// An account signed in with Google has no Apple grant. Which sign-ins an
// account has is now a lookup rather than something its id says, so this
// asks the accounts column and finds nothing to revoke.
func TestDeleteRevokesNothingForAnAccountWithNoAppleSignIn(t *testing.T) {
	credentials := &fakeAccounts{tokens: map[string]string{}}
	var revoked []string
	service, _ := newService(credentials, func(_ context.Context, token string) error {
		revoked = append(revoked, token)
		return nil
	})

	if err := service.Delete(context.Background(), "account-1"); err != nil {
		t.Fatal(err)
	}

	if len(revoked) != 0 {
		t.Errorf("expected nothing revoked, got %v", revoked)
	}
	if len(credentials.deleted) != 1 {
		t.Errorf("expected the account itself to be deleted, got %v", credentials.deleted)
	}
}

// Someone asking to delete their account gets that even when Apple is
// unreachable — the account is theirs, the outage isn't.
func TestDeleteProceedsWhenRevocationFails(t *testing.T) {
	credentials := &fakeAccounts{tokens: map[string]string{"account-1": "r-123"}}
	service, sessions := newService(credentials, func(context.Context, string) error {
		return errors.New("apple is down")
	})

	if err := service.Delete(context.Background(), "account-1"); err != nil {
		t.Fatal(err)
	}

	if len(sessions.sessionsDeletedFor) != 1 {
		t.Fatalf("expected deletion to finish despite the failed revoke")
	}
	if len(credentials.deleted) != 1 {
		t.Errorf("expected the account itself to be deleted, got %v", credentials.deleted)
	}
	// Kept, not dropped: it's all a retry would have to work from.
	want := dynamo.ProviderKey(auth.AppleProvider, "sub")
	if len(credentials.kept) != 1 || credentials.kept[0] != want {
		t.Errorf("expected the unspent grant %q to survive a failed revoke, got %v", want, credentials.kept)
	}
}

// An Apple account from before the grant was banked has a provider row
// but no token on it. Nothing to revoke, and nothing worth keeping.
func TestDeleteWithNothingBanked(t *testing.T) {
	credentials := &fakeAccounts{tokens: map[string]string{"account-1": ""}}
	var revoked []string
	service, _ := newService(credentials, func(_ context.Context, token string) error {
		revoked = append(revoked, token)
		return nil
	})

	if err := service.Delete(context.Background(), "account-1"); err != nil {
		t.Fatal(err)
	}
	if len(revoked) != 0 {
		t.Errorf("expected nothing revoked, got %v", revoked)
	}
	if len(credentials.kept) != 0 {
		t.Errorf("expected nothing kept, got %v", credentials.kept)
	}
}

// Revocation isn't wired at all when the environment has no Sign in with
// Apple key — deletion still has to work.
func TestDeleteWithoutRevocationConfigured(t *testing.T) {
	service, sessions := newService(&fakeAccounts{tokens: map[string]string{}}, nil)

	if err := service.Delete(context.Background(), "account-1"); err != nil {
		t.Fatal(err)
	}
	if len(sessions.sessionsDeletedFor) != 1 {
		t.Fatalf("expected an ordinary deletion")
	}
}

// fakeCircles is the other column's half: it reports what it erased so
// the bytes can go too.
type fakeCircles struct {
	name   string
	erased erase.Erased
	err    error
}

func (f *fakeCircles) Account(_ context.Context, _, name string) (erase.Erased, error) {
	f.name = name
	return f.erased, f.err
}

type fakeBlobs struct {
	deleted []string
	swept   []string
}

func (f *fakeBlobs) Delete(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return nil
}

func (f *fakeBlobs) DeletePrefix(_ context.Context, prefix string) error {
	f.swept = append(f.swept, prefix)
	return nil
}

// Deleting an account has to reach the circles too, and the bytes those
// rows pointed at. Without this the account left its posts, photos and
// memberships behind in every circle it was in.
func TestDeleteErasesTheCirclesAndTheirBytes(t *testing.T) {
	circles := &fakeCircles{erased: erase.Erased{
		BlobKeys: []string{"circle-1/post-1"},
		Prefixes: []string{"circle-2/"},
	}}
	blobs := &fakeBlobs{}
	service, sessions := newService(&fakeAccounts{tokens: map[string]string{}}, nil)
	service.Circles, service.Blobs = circles, blobs

	if err := service.Delete(context.Background(), "account-1"); err != nil {
		t.Fatal(err)
	}

	// The name is read while the profile is still there, because the
	// wall has to say who left.
	if circles.name != "Sarah" {
		t.Errorf("name = %q, want the profile's", circles.name)
	}
	if len(blobs.deleted) != 1 || blobs.deleted[0] != "circle-1/post-1" {
		t.Errorf("deleted %v", blobs.deleted)
	}
	if len(blobs.swept) != 1 || blobs.swept[0] != "circle-2/" {
		t.Errorf("swept %v", blobs.swept)
	}
	if len(sessions.sessionsDeletedFor) != 1 {
		t.Error("expected the sessions to go last")
	}
}

// If the circles cannot be erased, the account stays: deleting it first
// would leave content nobody can attribute and no membership to find it
// by, with nothing left that could retry.
func TestDeleteStopsWhenTheCirclesCannotBeErased(t *testing.T) {
	credentials := &fakeAccounts{tokens: map[string]string{}}
	service, sessions := newService(credentials, nil)
	service.Circles = &fakeCircles{err: errors.New("dynamo is down")}

	if err := service.Delete(context.Background(), "account-1"); err == nil {
		t.Fatal("expected the failure to reach the caller")
	}
	if len(credentials.deleted) != 0 {
		t.Error("the account must survive a failed erasure")
	}
	if len(sessions.sessionsDeletedFor) != 0 {
		t.Error("and so must its sessions")
	}
}
