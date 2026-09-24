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
 * half — without that, nothing can ever be sealed to this device. `reset`
 * follows `created`: a freshly minted keypair means every circle's
 * sealed keys need resealing, which is what `reset: true` tells the relay
 * to flag.
 *
 * Runs after every successful sign-in, not just the first — cheap when
 * nothing changed (the relay's SetPublicKey is a plain idempotent write
 * when `reset` is false), and it's what lets a returning device confirm
 * its key still matches what the relay has on file.
 */
async function ensurePublishedKeypair(): Promise<{ accountId: string; name: string }> {
  const relayProfile = await getRelayProfile();
  const { keypair, created } = await ensureAccountKeypair(relayProfile.accountId);
  const publicKey = toWire(keypair.publicKey);

  // A mint that contradicts a key the relay already has on file is the
  // possibility ensureAccountKeypair's own doc comment warns about, not
  // a confirmed loss: synced-store's retries shrink but do not close the
  // window where a still-restoring device reads empty before iCloud
  // Keychain/Block Store actually delivers the real key. Publishing this
  // as `reset` would be effectively irreversible — every circle this
  // account is in would have its members reseal to a key that gets
  // discarded the moment the real one shows up — so it is left
  // unpublished for this attempt; the next sign-in or launch gets
  // another chance to read the real key before anything commits.
  const ambiguousRestore = created && !!relayProfile.publicKey;
  if (!ambiguousRestore && (created || relayProfile.publicKey !== publicKey)) {
    await publishPublicKey(publicKey, created);
  }
  return { accountId: relayProfile.accountId, name: relayProfile.name };
}

/**
 * Runs the entire native Google sign-in flow — same shape as
 * signInWithApple below, now that @react-native-google-signin/google-signin
 * (a plain async function, not a React hook the way expo-auth-session's
 * Google prompt was) makes that possible.
 */
export async function signInWithGoogle(): Promise<SignInResult> {
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
    const relayProfile = await ensurePublishedKeypair();
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
export async function signInWithApple(): Promise<SignInResult> {
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
  const relayProfile = await ensurePublishedKeypair();

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
