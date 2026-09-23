jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(), signIn: jest.fn() },
  isErrorWithCode: () => false,
  isSuccessResponse: (response: unknown) => (response as { type?: string })?.type !== 'cancelled',
  statusCodes: { SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED' },
}));
jest.mock('expo-apple-authentication', () => ({
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
jest.mock('@/features/account/services/auth-relay');
jest.mock('@/features/account/services/account-relay');
jest.mock('@/features/push-notifications/usecases/enable-push', () => ({ unregisterPushEverywhere: jest.fn() }));
jest.mock('@/core/services/keystore/synced-store');

import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';

import { forgetAccountKeypair, getAccountKeypair } from '@/core/services/keystore/account-keypair';
import { signInWithApple, signInWithGoogle } from '@/features/account/usecases/sign-in';
import { getProfile, publishPublicKey } from '@/features/account/services/account-relay';
import { signInWithGoogle as relaySignInWithGoogle } from '@/features/account/services/auth-relay';

process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web-client-id';

const RELAY_PROFILE = { accountId: 'acc-1', name: '', createdAt: 0 };

beforeEach(async () => {
  jest.clearAllMocks();
  await forgetAccountKeypair();
  (relaySignInWithGoogle as jest.Mock).mockResolvedValue('session-token');
  (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE });
  (publishPublicKey as jest.Mock).mockResolvedValue({ awaitingRewrap: [] });
  (GoogleSignin.signIn as jest.Mock).mockResolvedValue({
    type: 'success',
    data: { idToken: 'id-token', user: { name: 'Ali', photo: null } },
  });
});

// This is the gap that made every circle operation fail silently: without
// it, getAccountKeypair() stays null forever and both creating and
// joining a circle are refused by the relay.
describe('publishing the account keypair', () => {
  test('a device with no keypair mints one and publishes it as a reset', async () => {
    await signInWithGoogle();

    const keypair = await getAccountKeypair();
    expect(keypair).not.toBeNull();
    const [publishedKey, reset] = (publishPublicKey as jest.Mock).mock.calls[0];
    expect(reset).toBe(true);
    expect(typeof publishedKey).toBe('string');
  });

  test('a device that already has a keypair matching the relay publishes nothing', async () => {
    await signInWithGoogle();
    (publishPublicKey as jest.Mock).mockClear();
    const keypair = await getAccountKeypair();
    (getProfile as jest.Mock).mockResolvedValue({
      ...RELAY_PROFILE,
      publicKey: Buffer.from(keypair!.publicKey).toString('base64'),
    });

    await signInWithGoogle();

    expect(publishPublicKey).not.toHaveBeenCalled();
  });

  test('a local key that does not match what the relay has on file is republished, not reset', async () => {
    await signInWithGoogle();
    (publishPublicKey as jest.Mock).mockClear();
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, publicKey: 'something-else' });

    await signInWithGoogle();

    const [, reset] = (publishPublicKey as jest.Mock).mock.calls[0];
    expect(reset).toBe(false);
  });

  test('the relay profile comes back to the caller either way', async () => {
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, name: 'Ali' });

    const result = await signInWithGoogle();

    expect(result.relayProfile).toEqual({ accountId: 'acc-1', name: 'Ali' });
  });

  test('Apple sign-in publishes the keypair too', async () => {
    (AppleAuthentication.signInAsync as jest.Mock).mockResolvedValue({
      identityToken: 'id-token',
      authorizationCode: 'auth-code',
      fullName: { givenName: 'Ali', familyName: null },
    });

    await signInWithApple();

    expect(await getAccountKeypair()).not.toBeNull();
    expect(publishPublicKey).toHaveBeenCalled();
  });
});

test('a cancelled sign-in never touches the keypair', async () => {
  (GoogleSignin.signIn as jest.Mock).mockResolvedValue({ type: 'cancelled' });

  const result = await signInWithGoogle();

  expect(result.outcome).toBe('cancelled');
  expect(await getAccountKeypair()).toBeNull();
  expect(publishPublicKey).not.toHaveBeenCalled();
});
