package dynamodb_test

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/push"
	"mimoza-relay/internal/util/testsupport"
)

func newStore(t *testing.T) push.Store {
	t.Helper()
	return testsupport.NewPushStore(t)
}

var ownerHash = []byte("thirty-two-bytes-of-owner-hash!!")

func samplePrefs() push.Prefs {
	return push.Prefs{Kind: push.KindCircle, PushFanoutHash: []byte("thirty-two-bytes-of-hash-here!!!"), OwnerHash: ownerHash, CategoryMask: 0b101, KeyVersion: 3}
}

func TestPrefsRoundTrip(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.PushFanoutHash) != string(samplePrefs().PushFanoutHash) {
		t.Fatalf("pushFanoutHash did not round-trip: %q", got.PushFanoutHash)
	}
	if got.CategoryMask != 0b101 || got.KeyVersion != 3 {
		t.Fatalf("expected mask 0b101 and version 3, got %b and %d", got.CategoryMask, got.KeyVersion)
	}
}

func TestGetPrefsUnregistered(t *testing.T) {
	store := newStore(t)

	_, err := store.GetPrefs(context.Background(), testsupport.UniqueInviteTag(t))
	if !errors.Is(err, push.ErrPushRoutingNotFound) {
		t.Fatalf("expected ErrPushRoutingNotFound, got %v", err)
	}
}

// A rotation rewrites prefs in place; the old hash must not survive.
func TestPutPrefsReplaces(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	rotated := push.Prefs{Kind: push.KindCircle, PushFanoutHash: []byte("a-completely-different-hash-here"), OwnerHash: ownerHash, CategoryMask: 0b1, KeyVersion: 4}
	if err := store.PutPrefs(ctx, pushRoutingID, rotated); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.PushFanoutHash) != string(rotated.PushFanoutHash) || got.KeyVersion != 4 {
		t.Fatalf("expected the rotated prefs, got version %d", got.KeyVersion)
	}
}

func TestDevicesRoundTrip(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	phone := push.Device{DeviceID: "phone", PushToken: []byte("enc-phone"), Platform: "ios", Enabled: true}
	tablet := push.Device{DeviceID: "tablet", PushToken: []byte("enc-tablet"), Platform: "android", Enabled: false}
	for _, device := range []push.Device{phone, tablet} {
		if err := store.PutDevice(ctx, pushRoutingID, device); err != nil {
			t.Fatal(err)
		}
	}

	devices, err := store.ListDevices(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(devices))
	}

	byID := map[string]push.Device{}
	for _, device := range devices {
		byID[device.DeviceID] = device
	}
	if got := byID["phone"]; string(got.PushToken) != "enc-phone" || got.Platform != "ios" || !got.Enabled {
		t.Fatalf("phone did not round-trip: %+v", got)
	}
	// Disabled rows come back too, so a caller can tell "no devices" from
	// "all muted" without a second read.
	if got := byID["tablet"]; got.Enabled {
		t.Fatalf("tablet should have come back disabled: %+v", got)
	}
}

// The device rows and the prefs row share a partition, so a bug in the
// sort-key prefix would have ListDevices return the prefs row as a device.
func TestListDevicesExcludesPrefsRow(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}

	devices, err := store.ListDevices(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("expected no devices, got %+v", devices)
	}
}

func TestListDevicesIsScopedToItsRoutingID(t *testing.T) {
	store := newStore(t)
	mine, theirs := testsupport.UniqueInviteTag(t), testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutDevice(ctx, theirs, push.Device{DeviceID: "d", PushToken: []byte("t"), Enabled: true}); err != nil {
		t.Fatal(err)
	}

	devices, err := store.ListDevices(ctx, mine)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("another routing id's devices leaked in: %+v", devices)
	}
}

func TestDeleteDevice(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutDevice(ctx, pushRoutingID, push.Device{DeviceID: "phone", PushToken: []byte("t"), Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDevice(ctx, pushRoutingID, "phone"); err != nil {
		t.Fatal(err)
	}

	devices, err := store.ListDevices(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("expected the device gone, got %+v", devices)
	}

	// Idempotent: unregistering twice is a normal retry.
	if err := store.DeleteDevice(ctx, pushRoutingID, "phone"); err != nil {
		t.Fatalf("deleting an absent device should succeed: %v", err)
	}
}

func TestDeleteRoutingRemovesPrefsAndDevices(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"phone", "tablet"} {
		if err := store.PutDevice(ctx, pushRoutingID, push.Device{DeviceID: id, PushToken: []byte("t"), Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.DeleteRouting(ctx, pushRoutingID); err != nil {
		t.Fatal(err)
	}

	if _, err := store.GetPrefs(ctx, pushRoutingID); !errors.Is(err, push.ErrPushRoutingNotFound) {
		t.Fatalf("expected the prefs row gone, got %v", err)
	}
	devices, err := store.ListDevices(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("expected every device row gone, got %+v", devices)
	}

	if err := store.DeleteRouting(ctx, pushRoutingID); err != nil {
		t.Fatalf("deleting absent routing should succeed: %v", err)
	}
}

// Silencing must not disturb the hash or categories, so unsilencing needs
// no content key.
func TestSetSilencedLeavesTheRestAlone(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSilenced(ctx, pushRoutingID, true); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Silenced {
		t.Fatal("expected the row silenced")
	}
	if string(got.PushFanoutHash) != string(samplePrefs().PushFanoutHash) || got.CategoryMask != 0b101 {
		t.Fatalf("silencing disturbed the rest of the row: %+v", got)
	}

	if err := store.SetSilenced(ctx, pushRoutingID, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetPrefs(ctx, pushRoutingID); got.Silenced {
		t.Fatal("expected the row unsilenced")
	}
}

func TestSetSilencedUnregistered(t *testing.T) {
	store := newStore(t)

	err := store.SetSilenced(context.Background(), testsupport.UniqueInviteTag(t), true)
	if !errors.Is(err, push.ErrPushRoutingNotFound) {
		t.Fatalf("expected ErrPushRoutingNotFound, got %v", err)
	}
}

// Registering a rotated push token must not restate the account's
// categories — the two rows are written independently on purpose.
func TestPutDeviceLeavesPrefsAlone(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	if err := store.PutDevice(ctx, pushRoutingID, push.Device{DeviceID: "phone", PushToken: []byte("t"), Enabled: true}); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CategoryMask != 0b101 {
		t.Fatalf("expected the mask untouched, got %b", got.CategoryMask)
	}
}

// Knowing a routing id, as every member does, must not be enough to
// rewrite its prefs.
func TestPutPrefsRefusesAnotherOwner(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	hijack := push.Prefs{PushFanoutHash: []byte("an-attackers-fanout-hash-32bytes"), OwnerHash: []byte("an-attackers-owner-hash-32-bytes")}
	if err := store.PutPrefs(ctx, pushRoutingID, hijack); !errors.Is(err, push.ErrNotOwner) {
		t.Fatalf("expected ErrNotOwner, got %v", err)
	}

	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.PushFanoutHash) != string(samplePrefs().PushFanoutHash) || string(got.OwnerHash) != string(ownerHash) {
		t.Fatal("the owner's prefs were replaced")
	}
}

func hasExpiry(t *testing.T, pk, sk string) bool {
	t.Helper()
	item, err := testsupport.RawPushItem(t, pk, sk)
	if err != nil {
		t.Fatal(err)
	}
	if item == nil {
		t.Fatalf("no item at %s/%s", pk, sk)
	}
	_, ok := item["expiresAt"]
	return ok
}

func TestKindRoundTrips(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()
	prefs := samplePrefs()
	prefs.Kind = push.KindInvite

	if err := store.PutPrefs(ctx, pushRoutingID, prefs); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetPrefs(ctx, pushRoutingID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != push.KindInvite {
		t.Fatalf("expected kind invite, got %q", got.Kind)
	}
}

// An invite or pending address a phone abandons must still go away.
func TestTemporaryKindsExpireAndCirclesDont(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()

	for kind, expires := range map[push.PushKind]bool{push.KindInvite: true, push.KindPendingRequest: true, push.KindCircle: false} {
		pushRoutingID := testsupport.UniqueInviteTag(t)
		prefs := samplePrefs()
		prefs.Kind = kind
		if err := store.PutPrefs(ctx, pushRoutingID, prefs); err != nil {
			t.Fatal(err)
		}
		device := push.Device{DeviceID: "d1", PushToken: []byte("t"), Platform: "ios", Enabled: true, Temporary: kind.Temporary()}
		if err := store.PutDevice(ctx, pushRoutingID, device); err != nil {
			t.Fatal(err)
		}

		if hasExpiry(t, pushRoutingID, "prefs") != expires || hasExpiry(t, pushRoutingID, "device#d1") != expires {
			t.Fatalf("%s: expected expiry %v on prefs and device", kind, expires)
		}
	}
}

// Joining keeps the requester's routing id and re-registers it as a circle.
// Both writes replace the whole row, so neither keeps the pending expiry.
func TestBecomingACircleClearsTheExpiry(t *testing.T) {
	store := newStore(t)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()

	pending := samplePrefs()
	pending.Kind = push.KindPendingRequest
	if err := store.PutPrefs(ctx, pushRoutingID, pending); err != nil {
		t.Fatal(err)
	}
	device := push.Device{DeviceID: "d1", PushToken: []byte("t"), Platform: "android", Enabled: true, Temporary: true}
	if err := store.PutDevice(ctx, pushRoutingID, device); err != nil {
		t.Fatal(err)
	}

	if err := store.PutPrefs(ctx, pushRoutingID, samplePrefs()); err != nil {
		t.Fatal(err)
	}
	device.Temporary = false
	if err := store.PutDevice(ctx, pushRoutingID, device); err != nil {
		t.Fatal(err)
	}

	if hasExpiry(t, pushRoutingID, "prefs") || hasExpiry(t, pushRoutingID, "device#d1") {
		t.Fatal("a circle address kept the pending expiry")
	}
}

// TTL deletes lazily; a temporary routing past its expiry must stop
// taking pushes at once, not whenever DynamoDB gets to it.
func TestAnExpiredTemporaryRoutingReadsAsGone(t *testing.T) {
	store := testsupport.NewPushStoreWithRetention(t, -1)
	pushRoutingID := testsupport.UniqueInviteTag(t)
	ctx := context.Background()
	prefs := samplePrefs()
	prefs.Kind = push.KindInvite

	if err := store.PutPrefs(ctx, pushRoutingID, prefs); err != nil {
		t.Fatal(err)
	}

	if _, err := store.GetPrefs(ctx, pushRoutingID); !errors.Is(err, push.ErrPushRoutingNotFound) {
		t.Fatalf("expected an expired routing to read as not found, got %v", err)
	}
}
