import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSignin, isErrorWithCode, isSuccessResponse, statusCodes } from '@react-native-google-signin/google-signin';
import { Platform } from 'react-native';

import { toWire } from '@/core/crypto/content';
import { deleteAuthToken, getAuthToken, saveAuthToken } from '@/core/services/keystore/auth-token';
import { ensureAccountKeypair } from '@/core/services/keystore/account-keypair';
import { unregisterPushEverywhere } from '@/features/push-notifications/usecases/enable-push';
import {
  logout as relayLogout,
  signInWithApple as relaySignInWithApple,
  signInWithGoogle as relaySignInWithGoogle,
} from '@/features/account/services/auth-relay';
import { getProfile as getRelayProfile, publishPublicKey } from '@/features/account/services/account-relay';

export type SignInOutcome = 'success' | 'cancelled';

/**
 * Thrown only by ensurePublishedKeypair, and only after the session
 * itself is already established (saveAuthToken has already run by the
 * time either caller reaches it) — so signInWithGoogle/signInWithApple
 * can tell "the sign-in itself failed" apart from "signed in fine, but
 * the keypair step didn't" instead of both looking like the same thrown
 * error. The account keypair is not required to use the app; a stale
 * server-side key is.
 */
export class KeypairPublishError extends Error {
  readonly accountId: string;
  readonly relayName: string;

  constructor(accountId: string, relayName: string, cause: unknown) {
    super('Signed in, but could not publish this device’s key.');
    this.name = 'KeypairPublishError';
    this.accountId = accountId;
    this.relayName = relayName;
    this.cause = cause;
  }
}

/**
 * suggestedName/suggestedPictureUrl are purely a profile-setup UX
 * convenience — never sent anywhere, just handed to the caller so it can
 * pre-fill the form instead of asking someone to retype what their sign-in
 * provider already told the device. Apple never provides a photo (Sign in
 * with Apple has no picture concept at all); its name is only ever
 * present on a person's very first authorization for this app, so it has
 * to be captured right here or it's gone for good.
 */
export type SignInResult = {
  outcome: SignInOutcome;
  suggestedName?: string;
  suggestedPictureUrl?: string;
  /**
   * What the relay already knows about this account. A name here means
   * this account has completed profile setup before — on some other
   * device, if this one has no local profile — so there's nothing to ask
   * again.
   */
  relayProfile?: { accountId: string; name: string };
};

let googleConfigured = false;

/**
 * GoogleSignin.configure() only needs to run once per process — lazy and
 * memoized here rather than at module scope, so a build missing the env
 * vars doesn't throw on import, only when sign-in is actually attempted.
 */
function ensureGoogleConfigured(): void {
  if (googleConfigured) return;
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  if (!webClientId) {
    // Required on every platform, not just iOS — the native SDK only
    // populates idToken in the response if webClientId is set, regardless
    // of which platform client actually drove the sign-in UI.
    throw new Error("Google sign-in isn't configured on this build yet.");
  }
  GoogleSignin.configure({ iosClientId, webClientId });
  googleConfigured = true;
}

/**
 * Ensures this device has an account keypair and the relay has its public
 * half. `reset` is true whenever this publish overwrites a *different* key
 * already on file — not whenever this call minted the keypair, since a
 * mint can happen on one sign-in and be left unpublished (see
 * ambiguousRestore below), with the actual publish landing on a later
 * call where `created` is already false.
 *
 * Runs after every successful sign-in, not just the first — cheap when
 * nothing changed, and it's what lets a returning device confirm its key
 * still matches the relay's.
 *
 * `onRecovering` fires once this account is known to have a profile
 * already — a missing local key then means this device is waiting on
 * iCloud Keychain/Block Store, not a fresh signup (which mints instantly
 * and never reaches this call).
 */
async function ensurePublishedKeypair(onRecovering?: () => void): Promise<{ accountId: string; name: string }> {
  const relayProfile = await getRelayProfile();
  if (relayProfile.name) onRecovering?.();
  try {
    const { keypair, created } = await ensureAccountKeypair(relayProfile.accountId);
    const publicKey = toWire(keypair.publicKey);
    const keyChanged = relayProfile.publicKey !== publicKey;

    // Might be a restore still in flight, not a confirmed loss (see
    // ensureAccountKeypair) — publishing as reset here would be
    // irreversible if so, so this is left unpublished for another chance.
    const ambiguousRestore = created && !!relayProfile.publicKey;
    if (ambiguousRestore) {
      console.warn(
        `ensurePublishedKeypair: minted a keypair for ${relayProfile.accountId} but left it unpublished — the relay already has a different key on file, and this may just be a restore still in flight.`
      );
    }
    if (!ambiguousRestore && (created || keyChanged)) {
      await publishPublicKey(publicKey, keyChanged);
    }
  } catch (err) {
    throw new KeypairPublishError(relayProfile.accountId, relayProfile.name, err);
  }
  return { accountId: relayProfile.accountId, name: relayProfile.name };
}

/**
 * Both callers use this instead of calling ensurePublishedKeypair
 * directly: by the time either reaches it, saveAuthToken has already
 * landed, so a keypair-specific failure here must not make a sign-in
 * that already succeeded look like it didn't. Anything else thrown
 * (a network error, the relay itself refusing) is a real sign-in
 * failure and still propagates.
 */
async function ensurePublishedKeypairOrDegrade(onRecovering?: () => void): Promise<{ accountId: string; name: string }> {
  try {
    return await ensurePublishedKeypair(onRecovering);
  } catch (err) {
    if (err instanceof KeypairPublishError) {
      console.error(err.message, err.cause);
      return { accountId: err.accountId, name: err.relayName };
    }
    throw err;
  }
}

/**
 * Runs the entire native Google sign-in flow — same shape as
 * signInWithApple below, now that @react-native-google-signin/google-signin
 * (a plain async function, not a React hook the way expo-auth-session's
 * Google prompt was) makes that possible.
 */
export async function signInWithGoogle(onRecovering?: () => void): Promise<SignInResult> {
  ensureGoogleConfigured();

  try {
    // Play Services availability only matters on Android — iOS has no
    // equivalent concept, and the native module doesn't require the check.
    if (Platform.OS === 'android') {
      await GoogleSignin.hasPlayServices();
    }
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) return { outcome: 'cancelled' };

    const idToken = response.data.idToken;
    if (!idToken) {
      throw new Error("Google didn't return an ID token — try again.");
    }
    const token = await relaySignInWithGoogle(idToken);
    await saveAuthToken(token);
    const relayProfile = await ensurePublishedKeypairOrDegrade(onRecovering);
    return {
      outcome: 'success',
      // .name is the combined display name — givenName/familyName are
      // reportedly unreliable on iOS (often null there), so this is the
      // one field actually worth relying on cross-platform.
      suggestedName: response.data.user.name ?? undefined,
      suggestedPictureUrl: response.data.user.photo ?? undefined,
      relayProfile,
    };
  } catch (err) {
    if (isErrorWithCode(err) && err.code === statusCodes.SIGN_IN_CANCELLED) {
      return { outcome: 'cancelled' };
    }
    throw err;
  }
}

/**
 * Runs the entire native Apple sign-in flow — prompt, extract the
 * identity token, exchange it with the relay, persist the session — so
 * callers get a plain pass/cancelled outcome, never
 * AppleAuthenticationCredential's shape or expo-apple-authentication's
 * own cancel error code.
 */
export async function signInWithApple(onRecovering?: () => void): Promise<SignInResult> {
  let credential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return { outcome: 'cancelled' };
    throw err;
  }

  if (!credential.identityToken) {
    throw new Error("Apple didn't return an identity token — try again.");
  }
  if (!credential.authorizationCode) {
    throw new Error("Apple didn't return an authorization code — try again.");
  }
  const token = await relaySignInWithApple(credential.identityToken, credential.authorizationCode);
  await saveAuthToken(token);
  const relayProfile = await ensurePublishedKeypairOrDegrade(onRecovering);

  const suggestedName = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ');
  return { outcome: 'success', suggestedName: suggestedName || undefined, relayProfile };
}

/**
 * Revokes the current session server-side and clears the locally stored
 * token. Deliberately *doesn't* touch the account keypair, circle keys, or
 * any local circle/post data — relay auth and local circle content are
 * decoupled by design, so signing out is meant to be low-stakes and
 * reversible: sign back in and everything local is exactly as you left
 * it. The server revoke is best-effort — offline or relay-down doesn't
 * block signing out locally.
 */
export async function signOut(): Promise<void> {
  const token = await getAuthToken();
  if (token) {
    try {
      await unregisterPushEverywhere();
    } catch (err) {
      console.error('Failed to disable notifications while signing out', err);
    }
    try {
      await relayLogout(token);
    } catch (err) {
      console.error('Failed to revoke session server-side', err);
    }
  }
  await deleteAuthToken();
}
