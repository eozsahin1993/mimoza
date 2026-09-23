jest.mock('@/features/push-notifications/services/register-device');
jest.mock('@/features/push-notifications/services/tokens');
jest.mock('@/core/services/settings');
jest.mock('expo-notifications', () => ({ getPermissionsAsync: jest.fn() }));

import { getPermissionsAsync } from 'expo-notifications';

import {
  answerNotificationPrompt,
  shouldOfferNotifications,
} from '@/features/push-notifications/usecases/enable-push';
import { registerThisDevice } from '@/features/push-notifications/services/register-device';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';
import { getAppSettings, updateAppSettings } from '@/core/services/settings';

const device = { pushToken: 'fcm-registration-token', platform: 'android' as const };
const SETTINGS = { notificationPromptAnswered: false };

function permission(granted: boolean, canAskAgain = true) {
  (getPermissionsAsync as jest.Mock).mockResolvedValue({ granted, canAskAgain });
}

beforeEach(() => {
  jest.clearAllMocks();
  (getAppSettings as jest.Mock).mockResolvedValue(SETTINGS);
  (updateAppSettings as jest.Mock).mockResolvedValue(undefined);
  (registerThisDevice as jest.Mock).mockResolvedValue(undefined);
});

describe('the home screen ask', () => {
  test('is offered while the OS would still prompt and it has no answer', async () => {
    permission(false);
    expect(await shouldOfferNotifications()).toBe(true);
  });

  test('is not offered once answered, granted, or refused for good', async () => {
    (getAppSettings as jest.Mock).mockResolvedValue({ notificationPromptAnswered: true });
    permission(false);
    expect(await shouldOfferNotifications()).toBe(false);

    (getAppSettings as jest.Mock).mockResolvedValue(SETTINGS);
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

  test('"Turn on" asks the OS and registers this device right away', async () => {
    (getDevicePushToken as jest.Mock).mockResolvedValue(device);

    await answerNotificationPrompt(true);

    expect(getDevicePushToken).toHaveBeenCalledWith({ ask: true });
    expect(registerThisDevice).toHaveBeenCalledTimes(1);
  });

  test('a refusal never registers', async () => {
    (getDevicePushToken as jest.Mock).mockResolvedValue(null);

    await answerNotificationPrompt(true);

    expect(registerThisDevice).not.toHaveBeenCalled();
  });
});
