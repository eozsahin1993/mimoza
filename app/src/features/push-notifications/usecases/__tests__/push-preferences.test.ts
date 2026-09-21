jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/push-relay');
jest.mock('@/core/photo/image');
jest.mock('@/core/services/settings');

import { getCircle, initDatabase } from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import {
  PushLevels,
  circlePushPreferences,
  isPushStale,
  levelForMask,
  maskForLevel,
  setCircleLevel,
  resyncPushIfStale,
  setCircleSilenced,
  syncPushPreferences,
} from '@/features/push-notifications/usecases/push-preferences';
import { PushCategories } from '@/features/push-notifications/usecases/push-categories';
import { saveMasterSeed } from '@/core/services/keystore/master-seed';
import { addCircleKeyVersion, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { deletePushRouting, putPushPrefs } from '@/core/services/push-relay';
import { appendEntry, bootstrapCircle } from '@/core/services/log-relay';
import { getAppSettings } from '@/core/services/settings';

const SETTINGS = { defaultPushLevel: 'comments', themePreference: 'system' as const };

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (putPushPrefs as jest.Mock).mockResolvedValue(undefined);
  (deletePushRouting as jest.Mock).mockResolvedValue(undefined);
  (getAppSettings as jest.Mock).mockResolvedValue(SETTINGS);
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(9));
});

test('silencing removes the routing row and is remembered locally', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  await setCircleSilenced(circleId, true);

  expect(deletePushRouting).toHaveBeenCalledTimes(1);
  expect((await circlePushPreferences(circleId)).silenced).toBe(true);
});

test('unsilencing re-registers with that circle categories', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await setCircleSilenced(circleId, true);

  await setCircleSilenced(circleId, false);

  expect((await circlePushPreferences(circleId)).silenced).toBe(false);
  expect((putPushPrefs as jest.Mock).mock.calls[0][2]).toEqual([0, 1, 3]);
});

/**
 * The local flag is what the toggle reads, so it has to survive the relay
 * being unreachable — otherwise the switch snaps back and the user can't
 * tell whether anything happened.
 */
test('a failed relay call still leaves the preference stored', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  (deletePushRouting as jest.Mock).mockRejectedValue(new Error('offline'));

  await expect(setCircleSilenced(circleId, true)).rejects.toThrow();

  expect((await circlePushPreferences(circleId)).silenced).toBe(true);
});

test('a settings change reaches every circle that is not silenced', async () => {
  const first = await createCircle({ name: 'Family Circle' });
  const second = await createCircle({ name: 'Book Club' });
  await setCircleSilenced(second.id, true);
  jest.clearAllMocks();
  (putPushPrefs as jest.Mock).mockResolvedValue(undefined);

  await syncPushPreferences();

  expect(putPushPrefs).toHaveBeenCalledTimes(1);
  expect(await getCircle(first.id)).toMatchObject({ pushSilenced: false });
});

/** One circle failing must not stop the others being updated. */
test('a circle that fails to sync does not stop the rest', async () => {
  await createCircle({ name: 'Family Circle' });
  await createCircle({ name: 'Book Club' });
  (putPushPrefs as jest.Mock).mockRejectedValueOnce(new Error('offline'));

  await expect(syncPushPreferences()).resolves.toBeUndefined();

  expect(putPushPrefs).toHaveBeenCalledTimes(2);
});

/** Per circle, so quietening one must not touch another. */
test('changing one circle leaves the others alone', async () => {
  const first = await createCircle({ name: 'Family Circle' });
  const second = await createCircle({ name: 'Book Club' });

  await setCircleLevel(first.id, 'posts');

  expect((await circlePushPreferences(first.id)).level).toBe('posts');
  expect((await circlePushPreferences(second.id)).level).toBe('comments');
});

test('the quietest level still sends new photos', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  await setCircleLevel(circleId, 'posts');

  expect((putPushPrefs as jest.Mock).mock.calls.at(-1)?.[2]).toEqual([PushCategories.newPost, PushCategories.memberJoined]);
});

/** Silencing must not lose the level, or unsilencing invents a new one. */
test('the level survives being silenced', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await setCircleLevel(circleId, 'comments');

  await setCircleSilenced(circleId, true);
  await setCircleSilenced(circleId, false);

  expect((await circlePushPreferences(circleId)).level).toBe('comments');
});

test('a level is a ladder: each one includes the one below', () => {
  expect(maskForLevel('posts')).toBe(0b1001);
  expect(maskForLevel('comments')).toBe(0b1011);
  expect(maskForLevel('reactions')).toBe(0b1111);
});

/** A security event, not a social one — no level turns it off. */
test('someone joining is in every level', () => {
  for (const level of PushLevels) {
    expect(maskForLevel(level.id) & (1 << PushCategories.memberJoined)).toBeTruthy();
  }
});

/** An unrecognised combination from another device reads as quieter, never louder. */
test('a mask that matches no level rounds down', () => {
  expect(levelForMask(0b0101)).toBe('posts');
  expect(levelForMask(0)).toBe('posts');
});

describe('after a key rotation', () => {
  async function rotate(circleId: string): Promise<number> {
    const current = await getCurrentContentKey(circleId);
    const version = current!.version + 1;
    await addCircleKeyVersion(circleId, version, new Uint8Array(32).fill(version));
    return version;
  }

  test('a circle this device never registered is left alone', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    await rotate(circleId);

    expect(await isPushStale(circleId)).toBe(false);
    await resyncPushIfStale(circleId);
    expect(putPushPrefs).not.toHaveBeenCalled();
  });

  test('a registered circle re-writes its hash for the new key', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    await setCircleLevel(circleId, 'comments');
    const version = await rotate(circleId);
    jest.clearAllMocks();
    (putPushPrefs as jest.Mock).mockResolvedValue(undefined);

    expect(await isPushStale(circleId)).toBe(true);
    await resyncPushIfStale(circleId);

    expect(putPushPrefs).toHaveBeenCalledTimes(1);
    expect((putPushPrefs as jest.Mock).mock.calls[0][3]).toBe(version);
    expect(await isPushStale(circleId)).toBe(false);
  });

  /** The lag is the only record that the re-sync is still owed, so a failure must leave it. */
  test('a failed re-sync stays stale for the next pass', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    await setCircleLevel(circleId, 'comments');
    await rotate(circleId);
    (putPushPrefs as jest.Mock).mockRejectedValueOnce(new Error('offline'));

    await expect(resyncPushIfStale(circleId)).rejects.toThrow();

    expect(await isPushStale(circleId)).toBe(true);
  });

  test('a silenced circle has no row to re-sync', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    await setCircleLevel(circleId, 'comments');
    await setCircleSilenced(circleId, true);
    await rotate(circleId);

    expect(await isPushStale(circleId)).toBe(false);
  });
});
