jest.mock('@/features/push-notifications/services/device-relay');
jest.mock('@/features/push-notifications/services/tokens');
jest.mock('@/core/services/settings');

import { initDatabase, saveProfile } from '@/data/db';
import { forgetProfile } from '@/data/db/profile';
import { registerDevice, unregisterDevice } from '@/features/push-notifications/services/device-relay';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';
import { registerThisDevice, unregisterThisDevice } from '@/features/push-notifications/services/register-device';
import { getAppSettings } from '@/core/services/settings';

const device = { pushToken: 'fcm-registration-token', platform: 'android' as const };

beforeAll(async () => {
  await initDatabase();
});

// Only the one row this slice reads, rather than a full-app reset this
// suite has no need for — see data/db/__tests__/profile.test.ts.
beforeEach(async () => {
  jest.clearAllMocks();
  await forgetProfile('account-1');
  (getAppSettings as jest.Mock).mockResolvedValue({ language: 'system' });
  (registerDevice as jest.Mock).mockResolvedValue(undefined);
  (unregisterDevice as jest.Mock).mockResolvedValue(undefined);
});

/** No device id minted yet (no profile row) means nothing to register under. */
test('does nothing without a device id', async () => {
  (getDevicePushToken as jest.Mock).mockResolvedValue(device);

  await registerThisDevice();

  expect(registerDevice).not.toHaveBeenCalled();
});

test('does nothing without permission, even with a device id', async () => {
  await saveProfile({ accountId: 'account-1', deviceId: 'device-1', name: '', picture: null, createdAt: 1, updatedAt: 1 });
  (getDevicePushToken as jest.Mock).mockResolvedValue(null);

  await registerThisDevice();

  expect(registerDevice).not.toHaveBeenCalled();
});

test('registers under the stored device id, with the platform token and app language', async () => {
  await saveProfile({ accountId: 'account-1', deviceId: 'device-1', name: '', picture: null, createdAt: 1, updatedAt: 1 });
  (getDevicePushToken as jest.Mock).mockResolvedValue(device);
  (getAppSettings as jest.Mock).mockResolvedValue({ language: 'tr' });

  await registerThisDevice();

  expect(registerDevice).toHaveBeenCalledWith('device-1', { ...device, locale: 'tr' });
});

/** Following the device's own language: nothing pinned, so the relay's own default applies. */
test('omits the locale while following the system language', async () => {
  await saveProfile({ accountId: 'account-1', deviceId: 'device-1', name: '', picture: null, createdAt: 1, updatedAt: 1 });
  (getDevicePushToken as jest.Mock).mockResolvedValue(device);
  (getAppSettings as jest.Mock).mockResolvedValue({ language: 'system' });

  await registerThisDevice();

  expect(registerDevice).toHaveBeenCalledWith('device-1', { ...device, locale: undefined });
});

/** A relay failure must never throw into the caller — see register-device.ts. */
test('a failed registration is swallowed', async () => {
  await saveProfile({ accountId: 'account-1', deviceId: 'device-1', name: '', picture: null, createdAt: 1, updatedAt: 1 });
  (getDevicePushToken as jest.Mock).mockResolvedValue(device);
  (registerDevice as jest.Mock).mockRejectedValue(new Error('offline'));

  await expect(registerThisDevice()).resolves.toBeUndefined();
});

test('unregisters under the stored device id', async () => {
  await saveProfile({ accountId: 'account-1', deviceId: 'device-1', name: '', picture: null, createdAt: 1, updatedAt: 1 });

  await unregisterThisDevice();

  expect(unregisterDevice).toHaveBeenCalledWith('device-1');
});

test('unregistering without a device id is a no-op', async () => {
  await unregisterThisDevice();

  expect(unregisterDevice).not.toHaveBeenCalled();
});
