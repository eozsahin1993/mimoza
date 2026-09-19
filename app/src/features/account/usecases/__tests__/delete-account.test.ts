jest.mock('@/core/services/log-relay');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/features/push-notifications/services/channels');

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { decrypt, generateIdentity, generateUUID, verify } from '@/core/crypto/primitives';
import { deriveCircleIdentity } from '@/core/crypto/identity';
import { getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { getMasterSeed, saveMasterSeed } from '@/core/services/keystore/master-seed';
import {
  appendEntry,
  bootstrapCircle,
  changeAuthority,
  deleteAccountOnRelay,
  deleteAuthorContentOnRelay,
  fetchEntries,
} from '@/core/services/log-relay';
import { CircleGoneError } from '@/core/services/relay-errors';
import { deleteCircle, getCircle, initDatabase, insertCircle, MemberRoles, recordMemberAddedLocally } from '@/data/db';
import { fetchAccountManifest } from '@/features/account/usecases/account-manifest';
import { deleteAccount, finishAccountDeletionIfPending } from '@/features/account/usecases/delete-account';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { finishDeparture } from '@/features/circle/usecases/leave-circle';

/**
 * A circle with a second member, so leaving it is an ordinary departure
 * (`member_removed`) rather than `leaveCircle`'s last-member-out branch
 * (`deleteCircleForEveryone`) — same reason `leave-circle.test.ts`'s own
 * `foundedCircle()` helper adds one.
 */
async function circleWithAnotherMember(name: string) {
  const { id: circleId } = await createCircle({ name });
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(generateIdentity().publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'bb', memberId: generateUUID(), role: MemberRoles.member, name: 'Rosa', picture: null },
  });
  return circleId;
}

beforeAll(async () => {
  await initDatabase();
});

// Every test's own deleteAccount() call must run to completion (or be
// explicitly cleaned up) before it ends — the master seed and the
// isDeletingAccount flag are both process-wide state this file's tests
// share, with no reset between them (same convention leave-circle.test.ts
// follows for the DB itself).
beforeEach(async () => {
  jest.clearAllMocks();
  await saveMasterSeed(new Uint8Array(16));
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  (changeAuthority as jest.Mock).mockResolvedValue({ epoch: 3, receivedAt: Date.now() });
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
  (fetchAccountManifest as jest.Mock).mockResolvedValue({});
  (deleteAuthorContentOnRelay as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (deleteAccountOnRelay as jest.Mock).mockResolvedValue(undefined);
});

test('queues a signed account_deleted entry ahead of the departure, for every joined circle', async () => {
  const circleId = await circleWithAnotherMember('Family Circle');
  const identity = (await getCircleIdentity(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;

  await deleteAccount();
  // leaveCircle's own push is fire-and-forget; settle it before asserting
  // — same reason leave-circle.test.ts does this after every leaveCircle
  // call. Reading the outbox table itself would be racy from here (it may
  // already have drained), so the assertions below read the relay mock's
  // own recorded call instead, which is unaffected by that timing.
  await finishDeparture(circleId);

  expect(deleteAuthorContentOnRelay).toHaveBeenCalledTimes(1);
  const [, authorKey, signature, tombstone] = (deleteAuthorContentOnRelay as jest.Mock).mock.calls[0];
  expect(bytesToHex(authorKey)).toBe(bytesToHex(identity.publicKey));
  expect(tombstone).toBeDefined();

  const envelope = JSON.parse(new TextDecoder().decode(decrypt(tombstone.encryptedMeta, current.key)));
  expect(envelope.type).toBe('account_deleted');
  expect(envelope.authorPubkey).toBe(bytesToHex(identity.publicKey));
  const verified = verify(
    hexToBytes(envelope.signature),
    new TextEncoder().encode(JSON.stringify({ type: envelope.type, payload: envelope.payload })),
    identity.publicKey
  );
  expect(verified).toBe(true);
  void signature;

  await finishAccountDeletionIfPending();
});

test('finishAccountDeletionIfPending is a no-op when no deletion is pending', async () => {
  await finishAccountDeletionIfPending();

  expect(deleteAccountOnRelay).not.toHaveBeenCalled();
});

test('waits for every joined circle to fully leave before deleting the account', async () => {
  const circleId = await circleWithAnotherMember('Family Circle');
  // account_deleted pushes via deleteAuthorContentOnRelay, not the
  // generic appendEntry path member_removed used to — this is the call
  // whose failure has to keep this circle's departure from landing.
  (deleteAuthorContentOnRelay as jest.Mock).mockRejectedValue(new Error('offline'));

  await deleteAccount();
  await finishAccountDeletionIfPending();

  expect(deleteAccountOnRelay).not.toHaveBeenCalled();

  // Clean up: let the departure actually land so it doesn't stay stuck
  // for later tests' listCircles()/getLeftCircles() checks.
  (deleteAuthorContentOnRelay as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  await finishDeparture(circleId);
  await finishAccountDeletionIfPending();
});

test('deletes the relay account and wipes local state once every circle has left', async () => {
  const circleId = await circleWithAnotherMember('Family Circle');

  await deleteAccount();
  await finishDeparture(circleId);
  await finishAccountDeletionIfPending();

  expect(await getCircle(circleId)).toBeNull();
  expect(deleteAccountOnRelay).toHaveBeenCalledTimes(1);
  expect(await getMasterSeed()).toBeNull();
});

test('a second call after completion is a no-op', async () => {
  const circleId = await circleWithAnotherMember('Family Circle');

  await deleteAccount();
  await finishDeparture(circleId);
  await finishAccountDeletionIfPending();
  (deleteAccountOnRelay as jest.Mock).mockClear();

  await finishAccountDeletionIfPending();

  expect(deleteAccountOnRelay).not.toHaveBeenCalled();
});

test('erases a departed circle by re-deriving its signing key, strip-only', async () => {
  const masterSeed = (await getMasterSeed())!;
  const circleId = 'left-circle';
  const syncId = 'sync-left-circle';
  (fetchAccountManifest as jest.Mock).mockResolvedValue({
    circles: [{ circleId, syncId, keyMap: {}, leftAt: 1000 }],
  });

  await deleteAccount();
  await finishAccountDeletionIfPending();

  expect(deleteAuthorContentOnRelay).toHaveBeenCalledTimes(1);
  const [calledSyncId, authorKey, , tombstone] = (deleteAuthorContentOnRelay as jest.Mock).mock.calls[0];
  expect(calledSyncId).toBe(syncId);
  expect(bytesToHex(authorKey)).toBe(bytesToHex(deriveCircleIdentity(masterSeed, circleId).publicKey));
  expect(tombstone).toBeUndefined();
  expect(deleteAccountOnRelay).toHaveBeenCalledTimes(1);
});

test('a legacy departure tombstone with no syncId is skipped, not retried forever', async () => {
  // The old two-field {circleId, leftAt} shape, from before DepartedCircle
  // kept an address — real data an existing account can still carry.
  (fetchAccountManifest as jest.Mock).mockResolvedValue({
    circles: [{ circleId: 'ancient-departure', leftAt: 1000 } as unknown as { circleId: string; syncId: string; keyMap: Record<string, string>; leftAt: number }],
  });

  await deleteAccount();
  await finishAccountDeletionIfPending();

  expect(deleteAuthorContentOnRelay).not.toHaveBeenCalled();
  expect(deleteAccountOnRelay).toHaveBeenCalledTimes(1);
});

test('a circle already deleted for everyone (404) is treated as done, not a failure', async () => {
  (fetchAccountManifest as jest.Mock).mockResolvedValue({
    circles: [{ circleId: 'gone', syncId: 'sync-gone', keyMap: {}, leftAt: 1000 }],
  });
  (deleteAuthorContentOnRelay as jest.Mock).mockRejectedValue(new CircleGoneError());

  await deleteAccount();
  await finishAccountDeletionIfPending();

  expect(deleteAccountOnRelay).toHaveBeenCalledTimes(1);
});

test('a genuine strip failure for a departed circle blocks the final wipe', async () => {
  (fetchAccountManifest as jest.Mock).mockResolvedValue({
    circles: [{ circleId: 'left-circle', syncId: 'sync-left-circle', keyMap: {}, leftAt: 1000 }],
  });
  (deleteAuthorContentOnRelay as jest.Mock).mockRejectedValue(new Error('offline'));

  await deleteAccount();
  await finishAccountDeletionIfPending();

  expect(deleteAccountOnRelay).not.toHaveBeenCalled();
  expect(await getMasterSeed()).not.toBeNull();

  // Clean up the stuck flag so it doesn't leak into later tests.
  (deleteAuthorContentOnRelay as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  await finishAccountDeletionIfPending();
});

// Last: this circle is deliberately never left (no identity/content key
// exists for it), so it would otherwise linger in listCircles() forever
// and break every later test's "every circle has left" check.
test('is best-effort across circles: one with no keys does not block another', async () => {
  const keyed = await circleWithAnotherMember('Keyed');
  const keyedSyncId = (await getCircle(keyed))!.syncId;
  const keylessId = generateUUID();
  await insertCircle({
    id: keylessId,
    name: 'Keyless',
    picture: null,
    syncId: generateUUID(),
    createdAt: Date.now(),
    leftAt: null,
    metaCursor: 0,
    contentCursor: 0,
    lastViewedAt: 0,
  });

  await expect(deleteAccount()).resolves.toBeUndefined();
  await finishDeparture(keyed);

  // Reading outbox 'pending' state here would be racy (the keyless
  // circle's extra failed loop iteration gives the background drain more
  // time to run) — the mocked relay call itself isn't.
  const calledSyncIds = (deleteAuthorContentOnRelay as jest.Mock).mock.calls.map(([syncId]) => syncId);
  expect(calledSyncIds).toContain(keyedSyncId);

  await deleteCircle(keylessId);
  await finishAccountDeletionIfPending();
});
