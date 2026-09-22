package deleteaccount

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/auth"
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

type fakeAppleCredentials struct {
	tokens   map[string]string
	getErr   error
	deleted  []string
	getCalls int
}

func (s *fakeAppleCredentials) SaveAppleRefreshToken(_ context.Context, accountID, token string) error {
	s.tokens[accountID] = token
	return nil
}

func (s *fakeAppleCredentials) GetAppleRefreshToken(_ context.Context, accountID string) (string, error) {
	s.getCalls++
	if s.getErr != nil {
		return "", s.getErr
	}
	return s.tokens[accountID], nil
}

func (s *fakeAppleCredentials) DeleteAppleRefreshToken(_ context.Context, accountID string) error {
	s.deleted = append(s.deleted, accountID)
	delete(s.tokens, accountID)
	return nil
}

func newService(credentials *fakeAppleCredentials, revoke func(context.Context, string) error) (*Service, *fakeAuthStore) {
	sessions := &fakeAuthStore{}
	service := &Service{AuthStore: sessions, RevokeApple: revoke}
	if credentials != nil {
		service.AppleCredentials = credentials
	}
	return service, sessions
}

// The Guideline 5.1.1(v) path: deleting an Apple account spends the
// banked refresh token, then drops it.
func TestDeleteRevokesTheAppleGrant(t *testing.T) {
	credentials := &fakeAppleCredentials{tokens: map[string]string{"apple:sub-1": "r-123"}}
	var revoked []string
	service, sessions := newService(credentials, func(_ context.Context, token string) error {
		revoked = append(revoked, token)
		return nil
	})

	if err := service.Delete(context.Background(), "apple:sub-1"); err != nil {
		t.Fatal(err)
	}

	if len(revoked) != 1 || revoked[0] != "r-123" {
		t.Fatalf("expected the stored refresh token to be revoked, got %v", revoked)
	}
	if len(credentials.deleted) != 1 {
		t.Errorf("expected the spent token to be deleted, got %v", credentials.deleted)
	}
	if len(sessions.sessionsDeletedFor) != 1 {
		t.Errorf("expected the sessions to be deleted too")
	}
}

// A Google account has no Apple grant, and must not cost a lookup
// pretending otherwise.
func TestDeleteSkipsRevocationForNonAppleAccounts(t *testing.T) {
	credentials := &fakeAppleCredentials{tokens: map[string]string{}}
	var revoked []string
	service, _ := newService(credentials, func(_ context.Context, token string) error {
		revoked = append(revoked, token)
		return nil
	})

	if err := service.Delete(context.Background(), "google:sub-1"); err != nil {
		t.Fatal(err)
	}

	if credentials.getCalls != 0 {
		t.Errorf("expected no credential lookup for a Google account, got %d", credentials.getCalls)
	}
	if len(revoked) != 0 {
		t.Errorf("expected nothing revoked, got %v", revoked)
	}
}

// Someone asking to delete their account gets that even when Apple is
// unreachable — the account is theirs, the outage isn't.
func TestDeleteProceedsWhenRevocationFails(t *testing.T) {
	credentials := &fakeAppleCredentials{tokens: map[string]string{"apple:sub-1": "r-123"}}
	service, sessions := newService(credentials, func(context.Context, string) error {
		return errors.New("apple is down")
	})

	if err := service.Delete(context.Background(), "apple:sub-1"); err != nil {
		t.Fatal(err)
	}

	if len(sessions.sessionsDeletedFor) != 1 {
		t.Fatalf("expected deletion to finish despite the failed revoke")
	}
	// Kept, not dropped: it's all a retry would have to work from.
	if len(credentials.deleted) != 0 {
		t.Errorf("expected the unspent token to survive a failed revoke, got %v", credentials.deleted)
	}
}

// An account that signed in with no Apple key configured has nothing
// banked; that's ordinary, not an error.
func TestDeleteWithNothingBanked(t *testing.T) {
	credentials := &fakeAppleCredentials{tokens: map[string]string{}}
	var revoked []string
	service, _ := newService(credentials, func(_ context.Context, token string) error {
		revoked = append(revoked, token)
		return nil
	})

	if err := service.Delete(context.Background(), "apple:sub-1"); err != nil {
		t.Fatal(err)
	}
	if len(revoked) != 0 {
		t.Errorf("expected nothing revoked, got %v", revoked)
	}
}

// Revocation isn't wired at all when the environment has no Sign in with
// Apple key — deletion still has to work.
func TestDeleteWithoutRevocationConfigured(t *testing.T) {
	service, sessions := newService(nil, nil)

	if err := service.Delete(context.Background(), "apple:sub-1"); err != nil {
		t.Fatal(err)
	}
	if len(sessions.sessionsDeletedFor) != 1 {
		t.Fatalf("expected an ordinary deletion")
	}
}
