jest.mock('@/features/account/services/account-relay');

import { initDatabase } from '@/data/db';
import { forgetProfile, getProfile } from '@/data/db/profile';
import { completeProfileSetup } from '@/features/account/usecases/onboarding';
import { setName } from '@/features/account/services/account-relay';

beforeAll(() => initDatabase());

beforeEach(async () => {
  jest.clearAllMocks();
  // One row per accountId, so a fresh test must not inherit the previous
  // test's row — completeProfileSetup's "keep the device id" behavior
  // would otherwise pass for the wrong reason.
  await forgetProfile('acc-1');
  (setName as jest.Mock).mockResolvedValue({ accountId: 'acc-1', name: 'Ali', createdAt: 0 });
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
});
