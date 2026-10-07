jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), signOut: jest.fn() },
}));
jest.mock('expo-apple-authentication', () => ({}));
jest.mock('@/features/account/services/auth-relay');
jest.mock('@/features/push-notifications/usecases/enable-push');
jest.mock('@/core/services/keystore/synced-store');

import { GoogleSignin } from '@react-native-google-signin/google-signin';

import { deleteAuthToken, getAuthToken, saveAuthToken } from '@/core/services/keystore/auth-token';
import { logout } from '@/features/account/services/auth-relay';
import { signOut } from '@/features/account/usecases/sign-in';
import { unregisterPushEverywhere } from '@/features/push-notifications/usecases/enable-push';

process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web-client-id';

beforeEach(async () => {
  jest.clearAllMocks();
  (GoogleSignin.signOut as jest.Mock).mockResolvedValue(null);
  (logout as jest.Mock).mockResolvedValue(undefined);
  (unregisterPushEverywhere as jest.Mock).mockResolvedValue(undefined);
  await saveAuthToken('session-token');
});

test('unregisters push while the session is still valid, then revokes it', async () => {
  const order: string[] = [];
  (unregisterPushEverywhere as jest.Mock).mockImplementation(async () => {
    order.push(`unregister:${await getAuthToken()}`);
  });
  (logout as jest.Mock).mockImplementation(async () => order.push('logout'));

  await signOut();

  expect(order).toEqual(['unregister:session-token', 'logout']);
  expect(await getAuthToken()).toBeNull();
});

test('still signs out when push cleanup throws', async () => {
  (unregisterPushEverywhere as jest.Mock).mockRejectedValue(new Error('database closed'));
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await signOut();

  expect(logout).toHaveBeenCalledWith('session-token');
  expect(await getAuthToken()).toBeNull();
});

test('no session, nothing to unregister or revoke', async () => {
  await deleteAuthToken();

  await signOut();

  expect(unregisterPushEverywhere).not.toHaveBeenCalled();
  expect(logout).not.toHaveBeenCalled();
});

test('forgets the Google account so the next sign-in shows the picker', async () => {
  await signOut();

  expect(GoogleSignin.signOut).toHaveBeenCalledTimes(1);
});

test('still signs out when Google cannot clear its account', async () => {
  (GoogleSignin.signOut as jest.Mock).mockRejectedValue(new Error('play services unavailable'));
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await signOut();

  expect(await getAuthToken()).toBeNull();
});
