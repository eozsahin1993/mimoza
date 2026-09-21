jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/push-relay');
jest.mock('@/core/photo/image');
jest.mock('@/features/push-notifications/services/tokens');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  getCircleMembers,
  getPendingOutboxEntries,
  initDatabase,
  setMemberPushRoutingId,
} from '@/data/db';
import { EntryTypes } from '@/core/sync/log-entry';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import { PushCategories } from '@/features/push-notifications/usecases/push-categories';
import {
  registerPushForCircle,
  silenceCircle,
  unregisterDeviceForCircle,
} from '@/features/push-notifications/usecases/push-registration';
import { derivePushRoutingId } from '@/core/crypto/identity';
import { derivePushFanoutHash, derivePushFanoutToken, derivePushOwnerToken } from '@/core/crypto/push';
import { deleteCircleKeys, getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { getMasterSeed, saveMasterSeed } from '@/core/services/keystore/master-seed';
import { deletePushDevice, deletePushRouting, putPushDevice, putPushPrefs } from '@/core/services/push-relay';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { appendEntry, bootstrapCircle } from '@/core/services/log-relay';
import { deleteAuthToken, saveAuthToken } from '@/core/services/keystore/auth-token';
import { enablePushEverywhere, unregisterPushEverywhere } from '@/features/push-notifications/usecases/enable-push';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';

const registration = {
  pushToken: 'fcm-registration-token',
  platform: 'android' as const,
  categories: [PushCategories.newPost, PushCategories.comment],
};

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  for (const fn of [putPushPrefs, putPushDevice, deletePushDevice, deletePushRouting]) {
    (fn as jest.Mock).mockResolvedValue(undefined);
  }
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(9));
});

test('registers prefs and this device against the derived routing id', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const seed = (await getMasterSeed())!;
  const current = (await getCurrentContentKey(circleId))!;

  await registerPushForCircle(circleId, registration);

  const pushRoutingId = derivePushRoutingId(seed, circleId);
  const ownerToken = derivePushOwnerToken(seed, pushRoutingId);
  const [prefsRoutingId, fanoutHash, categories, keyVersion, prefsOwner] = (putPushPrefs as jest.Mock).mock.calls[0];
  expect(prefsRoutingId).toBe(pushRoutingId);
  expect(fanoutHash).toEqual(derivePushFanoutHash(derivePushFanoutToken(current.key), pushRoutingId));
  expect(categories).toEqual([0, 1]);
  expect(keyVersion).toBe(current.version);
  expect(prefsOwner).toEqual(ownerToken);

  const [deviceRoutingId, , pushToken, platform, enabled, deviceOwner] = (putPushDevice as jest.Mock).mock.calls[0];
  expect(deviceRoutingId).toBe(pushRoutingId);
  expect(pushToken).toEqual(registration.pushToken);
  expect(platform).toBe('android');
  expect(enabled).toBe(true);
  expect(deviceOwner).toEqual(ownerToken);
});

/** Same seed, same routing id: every device on the account can prove it owns the row. */
test('the owner token is per routing id and never the routing id itself', () => {
  const seed = new Uint8Array(16).fill(7);
  const first = derivePushOwnerToken(seed, 'a'.repeat(64));

  expect(derivePushOwnerToken(seed, 'a'.repeat(64))).toEqual(first);
  expect(derivePushOwnerToken(seed, 'b'.repeat(64))).not.toEqual(first);
  expect(bytesToHex(first)).not.toBe('a'.repeat(64));
});

/** The relay never sees the token itself, only a hash it can compare. */
test('the fanout token stays on the device', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const current = (await getCurrentContentKey(circleId))!;

  await registerPushForCircle(circleId, registration);

  const sent = JSON.stringify((putPushPrefs as jest.Mock).mock.calls[0]);
  expect(sent).not.toContain(bytesToHex(derivePushFanoutToken(current.key)));
});

/**
 * A member who joined before push existed has no routing id on their
 * roster row, so enabling it has to announce one.
 */
test('announces a routing id when the roster does not have one yet', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const ownKey = bytesToHex(identity.publicKey);
  await setMemberPushRoutingId(circleId, ownKey, '');

  await registerPushForCircle(circleId, registration);

  const queued = (await getPendingOutboxEntries(circleId)).filter(
    (entry) => entry.entryType === EntryTypes.PUSH_ENABLED,
  );
  expect(queued).toHaveLength(1);

  const own = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === ownKey);
  expect(own?.pushRoutingId).toBe(derivePushRoutingId((await getMasterSeed())!, circleId));
});

/** createCircle and completeJoin already stamp it, so the usual path is silent. */
test('announces nothing when the roster already agrees', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  await registerPushForCircle(circleId, registration);
  await registerPushForCircle(circleId, registration);

  expect(await getPendingOutboxEntries(circleId)).toHaveLength(0);
  // The relay rows are still refreshed, since a token or category may have
  // changed even when the routing id hasn't.
  expect(putPushDevice as jest.Mock).toHaveBeenCalledTimes(2);
});

test('a circle with no content key registers nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await deleteCircleKeys(circleId);

  await registerPushForCircle(circleId, registration);

  expect(putPushPrefs).not.toHaveBeenCalled();
});

test('unregistering this device leaves the routing id in place', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await registerPushForCircle(circleId, registration);

  await unregisterDeviceForCircle(circleId);

  expect(deletePushDevice).toHaveBeenCalledTimes(1);
  expect(deletePushRouting).not.toHaveBeenCalled();
});

test('silencing a circle removes the routing id outright', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  await silenceCircle(circleId);

  const seed = (await getMasterSeed())!;
  const pushRoutingId = derivePushRoutingId(seed, circleId);
  expect(deletePushRouting).toHaveBeenCalledWith(pushRoutingId, derivePushOwnerToken(seed, pushRoutingId));
});

describe('signing out', () => {
  beforeEach(() => {
    (getDevicePushToken as jest.Mock).mockResolvedValue({ pushToken: 'fcm-registration-token', platform: 'android' });
  });

  afterEach(async () => {
    await deleteAuthToken();
  });

  test('removes this device from every circle', async () => {
    const first = await createCircle({ name: 'Family Circle' });
    const second = await createCircle({ name: 'Friends' });
    const seed = (await getMasterSeed())!;

    await unregisterPushEverywhere();

    const routingIds = (deletePushDevice as jest.Mock).mock.calls.map(([routingId]) => routingId);
    expect(routingIds.sort()).toEqual([derivePushRoutingId(seed, first.id), derivePushRoutingId(seed, second.id)].sort());
    expect(deletePushRouting).not.toHaveBeenCalled();
  });

  test('one circle failing does not keep the others registered', async () => {
    await createCircle({ name: 'Family Circle' });
    await createCircle({ name: 'Friends' });
    (deletePushDevice as jest.Mock).mockRejectedValueOnce(new Error('relay down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await unregisterPushEverywhere();

    expect(deletePushDevice).toHaveBeenCalledTimes(2);
  });

  test('launch registration does nothing without a session', async () => {
    await createCircle({ name: 'Family Circle' });
    jest.clearAllMocks();

    await enablePushEverywhere();
    expect(putPushDevice).not.toHaveBeenCalled();

    await saveAuthToken('session-token');
    await enablePushEverywhere();
    expect(putPushDevice).toHaveBeenCalledTimes(1);
  });
});

describe('the derivations', () => {
  test('a routing id is the same for one seed and different per circle', () => {
    const seed = new Uint8Array(16).fill(9);
    expect(derivePushRoutingId(seed, 'circle-1')).toBe(derivePushRoutingId(seed, 'circle-1'));
    expect(derivePushRoutingId(seed, 'circle-1')).not.toBe(derivePushRoutingId(seed, 'circle-2'));
    expect(derivePushRoutingId(seed, 'circle-1')).not.toBe(derivePushRoutingId(new Uint8Array(16).fill(1), 'circle-1'));
  });

  /** Salting is what stops a circle's rows sharing one clusterable value. */
  test('a fanout hash is bound to its routing id', () => {
    const token = derivePushFanoutToken(new Uint8Array(32).fill(4));
    expect(derivePushFanoutHash(token, 'push-routing-a')).not.toEqual(derivePushFanoutHash(token, 'push-routing-b'));
  });

  /** Removal rotates the content key, which is what revokes push. */
  test('a fanout token follows the content key', () => {
    expect(derivePushFanoutToken(new Uint8Array(32).fill(1))).not.toEqual(derivePushFanoutToken(new Uint8Array(32).fill(2)));
  });
});
