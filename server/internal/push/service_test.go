package push

import (
	"context"
	"errors"
	"testing"
)

// fakeStore drives Fanout's decisions without LocalStack.
type fakeStore struct {
	prefs   map[string]Prefs
	devices map[string][]Device
	// Proves a rejected target never reached the second read.
	listCalls int
	// Proves a refused write never reached the store.
	writes int
	err    error
}

func (f *fakeStore) PutPrefs(context.Context, string, Prefs) error { return nil }

func (f *fakeStore) GetPrefs(_ context.Context, pushRoutingID string) (*Prefs, error) {
	if f.err != nil {
		return nil, f.err
	}
	prefs, ok := f.prefs[pushRoutingID]
	if !ok {
		return nil, ErrPushRoutingNotFound
	}
	return &prefs, nil
}

func (f *fakeStore) SetSilenced(context.Context, string, bool) error { f.writes++; return nil }

func (f *fakeStore) PutDevice(context.Context, string, Device) error { f.writes++; return nil }

func (f *fakeStore) ListDevices(_ context.Context, pushRoutingID string) ([]Device, error) {
	f.listCalls++
	return f.devices[pushRoutingID], nil
}

func (f *fakeStore) DeleteDevice(context.Context, string, string) error { f.writes++; return nil }
func (f *fakeStore) DeleteRouting(context.Context, string) error        { f.writes++; return nil }

// countingLimit records its keys, to assert budget is charged only after
// verification.
type countingLimit struct {
	keys  []string
	allow bool
}

func (c *countingLimit) Allow(_ context.Context, key string) (bool, error) {
	c.keys = append(c.keys, key)
	return c.allow, nil
}

const token = "fanout-token"

func newService(t *testing.T, limit *countingLimit) (*Service, *fakeStore) {
	t.Helper()
	store := &fakeStore{
		prefs: map[string]Prefs{
			"routing-a": {PushFanoutHash: PushFanoutHash([]byte(token), "routing-a"), CategoryMask: 0b011},
			"routing-b": {PushFanoutHash: PushFanoutHash([]byte(token), "routing-b"), CategoryMask: 0b011},
		},
		devices: map[string][]Device{
			"routing-a": {{DeviceID: "d1", PushToken: []byte("t1"), Platform: "ios", Enabled: true}},
			"routing-b": {{DeviceID: "d2", PushToken: []byte("t2"), Platform: "android", Enabled: true}},
		},
	}
	return &Service{PushStore: store, RecipientLimit: limit}, store
}

func TestFanout_DeliversToVerifiedTargets(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	result, err := service.Fanout(context.Background(), []string{"routing-a", "routing-b"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 2 || result.Skipped != 0 {
		t.Fatalf("expected 2 deliveries and 0 skipped, got %d and %d", len(result.Deliveries), result.Skipped)
	}
}

// What the salted hash is for: another circle's member holds a different
// token, so naming your routing ids gets them nothing.
func TestFanout_WrongTokenDeliversNothing(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	result, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte("some-other-circles-token"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 || result.Skipped != 1 {
		t.Fatalf("expected the target skipped, got %d deliveries", len(result.Deliveries))
	}
}

// A hash valid for one routing id must not verify for another.
func TestFanout_HashIsBoundToItsRoutingID(t *testing.T) {
	service, store := newService(t, &countingLimit{allow: true})
	// Give routing-b the hash that belongs to routing-a.
	store.prefs["routing-b"] = Prefs{
		PushFanoutHash: PushFanoutHash([]byte(token), "routing-a"),
		CategoryMask:   0b011,
	}

	result, err := service.Fanout(context.Background(), []string{"routing-b"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 {
		t.Fatalf("a hash bound to another routing id must not verify, got %d deliveries", len(result.Deliveries))
	}
}

func TestFanout_UnregisteredTargetIsSkippedNotFatal(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	result, err := service.Fanout(context.Background(), []string{"never-registered", "routing-a"}, []byte(token), 0)
	if err != nil {
		t.Fatalf("an unknown routing id must not fail the whole send: %v", err)
	}
	if len(result.Deliveries) != 1 || result.Skipped != 1 {
		t.Fatalf("expected 1 delivered and 1 skipped, got %d and %d", len(result.Deliveries), result.Skipped)
	}
}

// Silencing flips a flag rather than deleting the row, so the send path
// has to honour it — a stale hash would otherwise still verify.
func TestFanout_SilencedRoutingGetsNothing(t *testing.T) {
	service, store := newService(t, &countingLimit{allow: true})
	prefs := store.prefs["routing-a"]
	prefs.Silenced = true
	store.prefs["routing-a"] = prefs

	result, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 || result.Skipped != 1 {
		t.Fatalf("a silenced routing id must get nothing, got %d deliveries", len(result.Deliveries))
	}
}

func TestFanout_DisabledCategoryIsSkipped(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	// Bits 0 and 1 are set; 2 is not.
	result, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte(token), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 {
		t.Fatalf("expected the disabled category skipped, got %d deliveries", len(result.Deliveries))
	}
}

func TestFanout_DisabledDeviceGetsNothing(t *testing.T) {
	service, store := newService(t, &countingLimit{allow: true})
	store.devices["routing-a"] = []Device{{DeviceID: "d1", PushToken: []byte("t1"), Enabled: false}}

	result, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 || result.Skipped != 1 {
		t.Fatalf("a muted device must not be delivered to, got %d deliveries", len(result.Deliveries))
	}
}

// One recipient's budget must not silence the rest of the circle.
func TestFanout_OverBudgetSkipsOnlyThatRecipient(t *testing.T) {
	limit := &countingLimit{allow: false}
	service, _ := newService(t, limit)

	result, err := service.Fanout(context.Background(), []string{"routing-a", "routing-b"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 0 || result.Skipped != 2 {
		t.Fatalf("expected both skipped on budget, got %d delivered", len(result.Deliveries))
	}
	if len(limit.keys) != 2 {
		t.Fatalf("expected the budget keyed per recipient, got keys %v", limit.keys)
	}
}

// The ordering that keeps the limiter from becoming the amplification:
// an unverified target must never reach the budget.
func TestFanout_UnverifiedTargetsNeverConsumeBudget(t *testing.T) {
	limit := &countingLimit{allow: true}
	service, store := newService(t, limit)

	_, err := service.Fanout(context.Background(), []string{"never-registered", "routing-a"}, []byte("wrong-token"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(limit.keys) != 0 {
		t.Fatalf("no budget should be consumed by unverified targets, got %v", limit.keys)
	}
	if store.listCalls != 0 {
		t.Fatalf("no device read should happen for unverified targets, got %d", store.listCalls)
	}
}

func TestFanout_RejectsTooManyTargets(t *testing.T) {
	service, _ := newService(t, &countingLimit{allow: true})

	targets := make([]string, MaxFanoutTargets+1)
	for i := range targets {
		targets[i] = "routing-a"
	}

	_, err := service.Fanout(context.Background(), targets, []byte(token), 0)
	if !errors.Is(err, ErrTooManyTargets) {
		t.Fatalf("expected ErrTooManyTargets, got %v", err)
	}
}

func TestFanout_StorageFailureIsFatal(t *testing.T) {
	service, store := newService(t, &countingLimit{allow: true})
	store.err = errors.New("dynamodb is down")

	if _, err := service.Fanout(context.Background(), []string{"routing-a"}, []byte(token), 0); err == nil {
		t.Fatal("a storage failure must not be reported as a silently skipped target")
	}
}

var ownerToken = []byte("the-owners-32-byte-owner-token!!")

func ownedService(t *testing.T) (*Service, *fakeStore) {
	t.Helper()
	store := &fakeStore{prefs: map[string]Prefs{
		"owned": {OwnerHash: OwnerHash(ownerToken, "owned")},
	}}
	return &Service{PushStore: store}, store
}

func TestOwnership_TheOwnerCanWrite(t *testing.T) {
	service, store := ownedService(t)
	ctx := context.Background()

	for name, write := range map[string]func() error{
		"device":   func() error { return service.PutDevice(ctx, "owned", Device{DeviceID: "d"}, ownerToken) },
		"silenced": func() error { return service.SetSilenced(ctx, "owned", true, ownerToken) },
		"delete":   func() error { return service.DeleteDevice(ctx, "owned", "d", ownerToken) },
		"routing":  func() error { return service.DeleteRouting(ctx, "owned", ownerToken) },
	} {
		if err := write(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if store.writes != 4 {
		t.Fatalf("expected 4 writes, got %d", store.writes)
	}
}

// Every member knows every routing id in their circle; only the owner's
// token may change one.
func TestOwnership_AnotherTokenIsRefused(t *testing.T) {
	service, store := ownedService(t)
	ctx := context.Background()
	other := []byte("somebody-elses-owner-token-32byt")

	for name, write := range map[string]func() error{
		"device":   func() error { return service.PutDevice(ctx, "owned", Device{DeviceID: "d"}, other) },
		"silenced": func() error { return service.SetSilenced(ctx, "owned", true, other) },
		"delete":   func() error { return service.DeleteDevice(ctx, "owned", "d", other) },
		"routing":  func() error { return service.DeleteRouting(ctx, "owned", other) },
	} {
		if err := write(); !errors.Is(err, ErrNotOwner) {
			t.Fatalf("%s: expected ErrNotOwner, got %v", name, err)
		}
	}
	if store.writes != 0 {
		t.Fatalf("a refused write reached the store %d times", store.writes)
	}
}

// With no prefs row there's nothing to protect, and deletes stay idempotent.
func TestOwnership_DeletesWithoutPrefsGoAhead(t *testing.T) {
	service, store := ownedService(t)
	ctx := context.Background()

	if err := service.DeleteRouting(ctx, "never-registered", ownerToken); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteDevice(ctx, "never-registered", "d", ownerToken); err != nil {
		t.Fatal(err)
	}
	if store.writes != 2 {
		t.Fatalf("expected both deletes to reach the store, got %d", store.writes)
	}
}

func TestOwnership_PutPrefsStampsTheOwnerHash(t *testing.T) {
	recorder := &recordingPrefsStore{}
	service := &Service{PushStore: recorder}

	if err := service.PutPrefs(context.Background(), "owned", Prefs{}, ownerToken); err != nil {
		t.Fatal(err)
	}
	if string(recorder.prefs.OwnerHash) != string(OwnerHash(ownerToken, "owned")) {
		t.Fatal("PutPrefs didn't pass the owner hash to the store")
	}
}

type recordingPrefsStore struct {
	fakeStore
	prefs Prefs
}

func (r *recordingPrefsStore) PutPrefs(_ context.Context, _ string, prefs Prefs) error {
	r.prefs = prefs
	return nil
}

// The line on a lock screen comes from the recipient's row, not the sender.
func TestFanout_DeliveryCarriesTheAddressKind(t *testing.T) {
	store := &fakeStore{
		prefs: map[string]Prefs{
			"invite-address": {Kind: KindInvite, PushFanoutHash: PushFanoutHash([]byte(token), "invite-address"), CategoryMask: 0b1},
		},
		devices: map[string][]Device{
			"invite-address": {{DeviceID: "d1", PushToken: []byte("t1"), Platform: "ios", Enabled: true}},
		},
	}
	service := &Service{PushStore: store, RecipientLimit: &countingLimit{allow: true}}

	result, err := service.Fanout(context.Background(), []string{"invite-address"}, []byte(token), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deliveries) != 1 || result.Deliveries[0].Kind != KindInvite {
		t.Fatalf("expected one delivery of kind invite, got %+v", result.Deliveries)
	}
}
