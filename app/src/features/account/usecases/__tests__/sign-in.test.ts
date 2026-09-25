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

import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';

import { signInWithApple, signInWithGoogle } from '@/features/account/usecases/sign-in';
import { getProfile } from '@/features/account/services/account-relay';
import { signInWithGoogle as relaySignInWithGoogle } from '@/features/account/services/auth-relay';

process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web-client-id';

const RELAY_PROFILE = { accountId: 'acc-1', name: '', createdAt: 0 };

beforeEach(async () => {
  jest.clearAllMocks();
  (relaySignInWithGoogle as jest.Mock).mockResolvedValue('session-token');
  (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE });
  (GoogleSignin.signIn as jest.Mock).mockResolvedValue({
    type: 'success',
    data: { idToken: 'id-token', user: { name: 'Ali', photo: null } },
  });
});

// sign-in.ts deliberately stops at the relay session and profile — the
// account keypair (resolving, publishing, resetting) is a separate flow
// the caller runs afterward; see resolve-account-keypair.test.ts and
// publish-account-keypair.test.ts.
describe('signing in', () => {
  test('the relay profile comes back to the caller', async () => {
    (getProfile as jest.Mock).mockResolvedValue({ ...RELAY_PROFILE, name: 'Ali' });

    const result = await signInWithGoogle();

    expect(result.outcome).toBe('success');
    expect(result.relayProfile).toEqual({ accountId: 'acc-1', name: 'Ali' });
  });

  test('a cancelled sign-in never reaches the relay profile', async () => {
    (GoogleSignin.signIn as jest.Mock).mockResolvedValue({ type: 'cancelled' });

    const result = await signInWithGoogle();

    expect(result.outcome).toBe('cancelled');
    expect(getProfile).not.toHaveBeenCalled();
  });

  test('Apple sign-in resolves the relay profile too', async () => {
    (AppleAuthentication.signInAsync as jest.Mock).mockResolvedValue({
      identityToken: 'id-token',
      authorizationCode: 'auth-code',
      fullName: { givenName: 'Ali', familyName: null },
    });

    const result = await signInWithApple();

    expect(result.outcome).toBe('success');
    // Narrowed on purpose — createdAt and the public key are the relay's
    // business, not the caller's.
    expect(result.relayProfile).toEqual({ accountId: 'acc-1', name: '' });
  });
});
