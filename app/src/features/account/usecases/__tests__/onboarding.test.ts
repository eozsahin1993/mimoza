jest.mock('@/features/account/services/account-relay');
jest.mock('@/features/circle/usecases/set-member-avatar');

import { initDatabase } from '@/data/db';
import { forgetProfile, getProfile } from '@/data/db/profile';
import { completeProfileSetup } from '@/features/account/usecases/onboarding';
import { setName } from '@/features/account/services/account-relay';
import { syncOwnAvatarBestEffort } from '@/features/circle/usecases/set-member-avatar';

beforeAll(() => initDatabase());

beforeEach(async () => {
  jest.clearAllMocks();
  // One row per accountId, so a fresh test must not inherit the previous
  // test's row — completeProfileSetup's "keep the device id" behavior
  // would otherwise pass for the wrong reason.
  await forgetProfile('acc-1');
  (setName as jest.Mock).mockResolvedValue({ accountId: 'acc-1', name: 'Ali', createdAt: 0 });
  (syncOwnAvatarBestEffort as jest.Mock).mockResolvedValue(undefined);
});

describe('completeProfileSetup', () => {
  test('saves the local profile and publishes the name to the relay', async () => {
    const picture = new Uint8Array([1, 2, 3]);

    await completeProfileSetup({ name: 'Ali', picture });

    expect(setName).toHaveBeenCalledWith('Ali');
    const profile = await getProfile();
    expect(profile?.accountId).toBe('acc-1');
    expect(profile?.name).toBe('Ali');
    expect(profile?.picture).toEqual(picture);
  });

  test('mints a device id the first time', async () => {
    await completeProfileSetup({ name: 'Ali', picture: null });

    expect((await getProfile())?.deviceId).toBeTruthy();
  });

  // A fresh id on every edit would silently orphan this device's push
  // registration under the old one.
  test('editing a profile keeps the same device id', async () => {
    await completeProfileSetup({ name: 'Ali', picture: null });
    const deviceId = (await getProfile())?.deviceId;

    (setName as jest.Mock).mockResolvedValue({ accountId: 'acc-1', name: 'Ali Osman', createdAt: 0 });
    await completeProfileSetup({ name: 'Ali Osman', picture: null });

    expect((await getProfile())?.deviceId).toBe(deviceId);
    expect((await getProfile())?.name).toBe('Ali Osman');
  });

  test('editing a profile keeps the original createdAt', async () => {
    await completeProfileSetup({ name: 'Ali', picture: null });
    const createdAt = (await getProfile())?.createdAt;

    await completeProfileSetup({ name: 'Ali Osman', picture: null });

    expect((await getProfile())?.createdAt).toBe(createdAt);
  });

  // Every circle roster reads a member's own avatarId off that circle's
  // membership row, sealed under its own key — the account-level name
  // update above has nothing equivalent to reach, so a first picture (or
  // a changed one) has to be pushed out separately.
  test('syncs a first picture to every circle', async () => {
    const picture = new Uint8Array([1, 2, 3]);

    await completeProfileSetup({ name: 'Ali', picture });

    expect(syncOwnAvatarBestEffort).toHaveBeenCalledWith('acc-1', picture);
  });

  test('does not resync the picture on a name-only edit', async () => {
    const picture = new Uint8Array([1, 2, 3]);
    await completeProfileSetup({ name: 'Ali', picture });
    jest.clearAllMocks();

    await completeProfileSetup({ name: 'Ali Osman', picture });

    expect(syncOwnAvatarBestEffort).not.toHaveBeenCalled();
  });

  test('resyncs when the picture actually changes', async () => {
    await completeProfileSetup({ name: 'Ali', picture: new Uint8Array([1, 2, 3]) });
    jest.clearAllMocks();

    const nextPicture = new Uint8Array([4, 5, 6]);
    await completeProfileSetup({ name: 'Ali', picture: nextPicture });

    expect(syncOwnAvatarBestEffort).toHaveBeenCalledWith('acc-1', nextPicture);
  });

  test('does not sync when the picture is removed', async () => {
    await completeProfileSetup({ name: 'Ali', picture: new Uint8Array([1, 2, 3]) });
    jest.clearAllMocks();

    await completeProfileSetup({ name: 'Ali', picture: null });

    expect(syncOwnAvatarBestEffort).not.toHaveBeenCalled();
  });
});
