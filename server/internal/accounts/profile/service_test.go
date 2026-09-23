package profile

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/accounts"
	"mimoza-relay/internal/circles"
)

type fakeStore struct {
	profile   accounts.Profile
	publicKey []byte
	setErr    error
	keyErr    error
}

func (f *fakeStore) GetProfile(context.Context, string) (accounts.Profile, error) {
	return f.profile, nil
}

func (f *fakeStore) SetProfile(_ context.Context, accountID, name string) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.profile = accounts.Profile{AccountID: accountID, Name: name}
	return nil
}

func (f *fakeStore) SetPublicKey(_ context.Context, _ string, publicKey []byte) error {
	if f.keyErr != nil {
		return f.keyErr
	}
	f.publicKey = publicKey
	return nil
}

type fakeCircles struct {
	waiting []string
	err     error
	calls   int
}

func (f *fakeCircles) MarkMembershipsNeedRewrap(context.Context, string) ([]string, error) {
	f.calls++
	return f.waiting, f.err
}

// Setting a profile answers with the stored one rather than the request,
// so a device never has to read back what it just wrote.
func TestSetAnswersWithTheStoredProfile(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store}

	got, err := service.Set(context.Background(), "account-1", "Sarah")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Sarah" || got.AccountID != "account-1" {
		t.Fatalf("expected the stored profile back, got %+v", got)
	}
}

// Publishing a key is not the same as losing one: a first device's key
// leaves every circle readable, so nothing is asked to reseal.
func TestPublishingAKeyWithoutAResetAsksNobodyToReseal(t *testing.T) {
	store := &fakeStore{}
	circles := &fakeCircles{waiting: []string{"circle-1"}}
	service := &Service{Store: store, Circles: circles}

	waiting, err := service.SetPublicKey(context.Background(), "account-1", []byte("key"), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 0 {
		t.Errorf("expected nothing waiting, got %v", waiting)
	}
	if circles.calls != 0 {
		t.Errorf("expected the circles column to be left alone, got %d calls", circles.calls)
	}
	if string(store.publicKey) != "key" {
		t.Errorf("expected the key to be published anyway, got %q", store.publicKey)
	}
}

// A reset is a device with no private key: every copy sealed to the old
// one is unreadable, so each circle is flagged and named back to the
// caller as what it is waiting on.
func TestAResetFlagsEveryCircleAndNamesThem(t *testing.T) {
	circles := &fakeCircles{waiting: []string{"circle-1", "circle-2"}}
	service := &Service{Store: &fakeStore{}, Circles: circles}

	waiting, err := service.SetPublicKey(context.Background(), "account-1", []byte("new"), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 2 || waiting[0] != "circle-1" {
		t.Fatalf("expected both circles back, got %v", waiting)
	}
	if circles.calls != 1 {
		t.Errorf("expected one pass over the memberships, got %d", circles.calls)
	}
}

// A key that could not be stored must not flag anything: the circles
// would be marked unreadable while the old key still works.
func TestAFailedKeyWriteFlagsNothing(t *testing.T) {
	circles := &fakeCircles{}
	service := &Service{Store: &fakeStore{keyErr: errors.New("dynamo is down")}, Circles: circles}

	if _, err := service.SetPublicKey(context.Background(), "account-1", []byte("new"), true); err == nil {
		t.Fatal("expected the write to fail")
	}
	if circles.calls != 0 {
		t.Errorf("expected nothing flagged after a failed write, got %d calls", circles.calls)
	}
}

// The flagging failing is not the key failing. The caller is told,
// because a device that thinks it is waiting on a reseal nobody was
// asked for waits forever.
func TestAFailedFlaggingIsReported(t *testing.T) {
	circles := &fakeCircles{err: errors.New("dynamo is down")}
	service := &Service{Store: &fakeStore{}, Circles: circles}

	if _, err := service.SetPublicKey(context.Background(), "account-1", []byte("new"), true); err == nil {
		t.Fatal("expected the failure to reach the caller")
	}
}

// The relay runs with the circles column wired; without it a reset still
// publishes the key rather than panicking.
func TestAResetWithoutTheCirclesColumnStillPublishes(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store}

	waiting, err := service.SetPublicKey(context.Background(), "account-1", []byte("new"), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 0 {
		t.Errorf("expected nothing waiting, got %v", waiting)
	}
	if string(store.publicKey) != "new" {
		t.Errorf("expected the key to be published, got %q", store.publicKey)
	}
}

// A profile write that fails must not answer with a stale read.
func TestAFailedProfileWriteIsNotAnsweredWithTheOldOne(t *testing.T) {
	service := &Service{Store: &fakeStore{
		profile: accounts.Profile{AccountID: "account-1", Name: "Old"},
		setErr:  accounts.ErrNotFound,
	}}

	got, err := service.Set(context.Background(), "account-1", "Sarah")
	if !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if got.Name != "" {
		t.Errorf("expected an empty profile on failure, got %+v", got)
	}
}

type fakeNotifier struct{ events []circles.Notification }

func (f *fakeNotifier) Notify(_ context.Context, event circles.Notification) {
	f.events = append(f.events, event)
}

// A device with no private key waits for another member to reseal. The
// reset wakes them silently, or it waits on someone opening the app.
func TestAResetWakesTheOtherMembers(t *testing.T) {
	notifier := &fakeNotifier{}
	service := &Service{
		Store:   &fakeStore{},
		Circles: &fakeCircles{waiting: []string{"circle-1", "circle-2"}},
		Notify:  notifier,
	}

	if _, err := service.SetPublicKey(context.Background(), "account-1", []byte("new"), true); err != nil {
		t.Fatal(err)
	}

	if len(notifier.events) != 2 {
		t.Fatalf("expected one wake per circle, got %d", len(notifier.events))
	}
	for _, event := range notifier.events {
		if event.Kind != circles.NotifyRoster {
			t.Errorf("kind = %q, want a silent roster nudge", event.Kind)
		}
		if event.ActorID != "account-1" {
			t.Errorf("the account that reset must not wake itself: %+v", event)
		}
	}
}

// Publishing a first key wakes nobody: nothing is waiting on a reseal.
func TestPublishingAKeyWakesNobody(t *testing.T) {
	notifier := &fakeNotifier{}
	service := &Service{
		Store:   &fakeStore{},
		Circles: &fakeCircles{waiting: []string{"circle-1"}},
		Notify:  notifier,
	}

	if _, err := service.SetPublicKey(context.Background(), "account-1", []byte("first"), false); err != nil {
		t.Fatal(err)
	}
	if len(notifier.events) != 0 {
		t.Errorf("expected nothing woken, got %+v", notifier.events)
	}
}
