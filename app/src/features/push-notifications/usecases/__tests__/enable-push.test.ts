jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/push-relay');
jest.mock('@/core/photo/image');
jest.mock('@/features/push-notifications/services/tokens');
jest.mock('@/core/services/settings');
jest.mock('expo-notifications', () => ({ getPermissionsAsync: jest.fn() }));

import { getPermissionsAsync } from 'expo-notifications';

import { initDatabase, setCirclePushSilenced } from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import {
  answerNotificationPrompt,
  ensurePushForCircle,
  shouldOfferNotifications,
} from '@/features/push-notifications/usecases/enable-push';
import { saveMasterSeed } from '@/core/services/keystore/master-seed';
import { saveAuthToken } from '@/core/services/keystore/auth-token';
import { putPushDevice, putPushPrefs } from '@/core/services/push-relay';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { appendEntry, bootstrapCircle } from '@/core/services/log-relay';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';
import { getAppSettings, updateAppSettings } from '@/core/services/settings';

const device = { pushToken: 'fcm-registration-token', platform: 'android' as const };
const SETTINGS = { defaultPushLevel: 'comments', themePreference: 'system' as const, language: 'system' as const };

function permission(granted: boolean, canAskAgain = true) {
  (getPermissionsAsync as jest.Mock).mockResolvedValue({ granted, canAskAgain });
}

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (putPushPrefs as jest.Mock).mockResolvedValue(undefined);
  (putPushDevice as jest.Mock).mockResolvedValue(undefined);
  (getAppSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, notificationPromptAnswered: false });
  (updateAppSettings as jest.Mock).mockResolvedValue(undefined);
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(9));
  await saveAuthToken('session-token');
});

describe('the home screen ask', () => {
  test('is offered while the OS would still prompt and it has no answer', async () => {
    permission(false);
    expect(await shouldOfferNotifications()).toBe(true);
  });

  test('is not offered once answered, granted, or refused for good', async () => {
    (getAppSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, notificationPromptAnswered: true });
    permission(false);
    expect(await shouldOfferNotifications()).toBe(false);

    (getAppSettings as jest.Mock).mockResolvedValue({ ...SETTINGS, notificationPromptAnswered: false });
    permission(true);
    expect(await shouldOfferNotifications()).toBe(false);

    permission(false, false);
    expect(await shouldOfferNotifications()).toBe(false);
  });

  /** "Not now" must leave the OS prompt unspent. */
  test('"Not now" records the answer without asking the OS', async () => {
    await answerNotificationPrompt(false);

    expect(updateAppSettings).toHaveBeenCalledWith({ notificationPromptAnswered: true });
    expect(getDevicePushToken).not.toHaveBeenCalled();
  });

  test('"Turn on" asks the OS and registers every circle right away', async () => {
    await createCircle({ name: 'Family Circle' });
    (getDevicePushToken as jest.Mock).mockResolvedValue(device);
    permission(true);

    await answerNotificationPrompt(true);

    expect(getDevicePushToken).toHaveBeenCalledWith({ ask: true });
    expect(putPushPrefs).toHaveBeenCalledTimes(1);
    expect(putPushDevice).toHaveBeenCalledTimes(1);
  });
});

describe('opening a feed', () => {
  /** A circle created or joined since launch; launch never saw it. */
  test('registers a circle this phone never has, once', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    (getDevicePushToken as jest.Mock).mockResolvedValue(device);

    await ensurePushForCircle(circleId);
    await ensurePushForCircle(circleId);

    expect(putPushPrefs).toHaveBeenCalledTimes(1);
    expect(putPushDevice).toHaveBeenCalledTimes(1);
  });

  test('never prompts, and does nothing without permission', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    (getDevicePushToken as jest.Mock).mockResolvedValue(null);

    await ensurePushForCircle(circleId);

    expect(getDevicePushToken).toHaveBeenCalledWith();
    expect(putPushPrefs).not.toHaveBeenCalled();
  });

  test('leaves a silenced circle alone', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    await setCirclePushSilenced(circleId, true);
    (getDevicePushToken as jest.Mock).mockResolvedValue(device);

    await ensurePushForCircle(circleId);

    expect(putPushPrefs).not.toHaveBeenCalled();
  });
});
