import { toWire } from '@/core/crypto/content';
import { getAccountKeypair, mintAndSaveAccountKeypair } from '@/core/services/keystore/account-keypair';
import { getProfile as getRelayProfile, publishPublicKey } from '@/features/account/services/account-relay';
import type { Keypair } from '@/core/crypto/primitives';

/**
 * What a caller needs to decide what to do next — never a callback, since
 * the real choice for `needsRecovery` is "navigate to a whole screen",
 * which doesn't fit through a Promise-returning callback the way a dialog
 * would.
 *
 * - `inSync`: this device's local keypair matches what the relay has on
 *   file. Nothing to do.
 * - `keypairMismatch`: this device *has* a local keypair, but it differs
 *   from the relay's — most often a leftover from an earlier sign-in that
 *   minted one and declined to publish it (see publishAccountKeypair's
 *   ambiguousRestore). There is nothing to ask the user: this key is
 *   already usable, it just needs telling to the relay as a reset.
 * - `freshSignup`: no local keypair, and the relay has never heard of this
 *   account either (no name on file) — a brand new account minting its
 *   first keypair. Mint and move on; there is nothing to recover.
 * - `needsRecovery`: no local keypair, but the relay already knows this
 *   account (a name on file) — a real returning account whose key is
 *   actually missing. This is the case that should navigate to a
 *   "scan another device or create a new key" screen instead of minting
 *   silently.
 */
export const KeypairStatuses = {
  IN_SYNC: 'inSync',
  KEYPAIR_MISMATCH: 'keypairMismatch',
  FRESH_SIGNUP: 'freshSignup',
  NEEDS_RECOVERY: 'needsRecovery',
} as const;

export type AccountKeypairStatus =
  | { kind: typeof KeypairStatuses.IN_SYNC }
  | { kind: typeof KeypairStatuses.KEYPAIR_MISMATCH; keypair: Keypair }
  | { kind: typeof KeypairStatuses.FRESH_SIGNUP }
  | { kind: typeof KeypairStatuses.NEEDS_RECOVERY };

export async function checkAccountKeypairStatus(accountId: string): Promise<AccountKeypairStatus> {
  const relayProfile = await getRelayProfile();
  const keypair = await getAccountKeypair(accountId);
  if (keypair) {
    return toWire(keypair.publicKey) === relayProfile.publicKey
      ? { kind: KeypairStatuses.IN_SYNC }
      : { kind: KeypairStatuses.KEYPAIR_MISMATCH, keypair };
  }
  return relayProfile.name ? { kind: KeypairStatuses.NEEDS_RECOVERY } : { kind: KeypairStatuses.FRESH_SIGNUP };
}

/**
 * Thrown only after the caller's own session is already established, so it
 * can tell "sign-in itself failed" apart from "signed in fine, but the
 * keypair step didn't" instead of both looking like the same thrown error.
 * The account keypair is not required to use the app; a stale server-side
 * key is.
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
 * Tells the relay about a keypair the caller already has in hand — from
 * checkAccountKeypairStatus's `keypairMismatch`, a fresh mint, or a keypair
 * adopted from another device via a scan. Knows nothing about how it was
 * obtained beyond `created`. `reset` is true whenever this overwrites a
 * *different* key already on file — not whenever `created` is true, since
 * a first-ever signup also mints with nothing to have lost.
 */
export async function publishAccountKeypair(accountId: string, keypair: Keypair, created: boolean): Promise<void> {
  const relayProfile = await getRelayProfile();
  try {
    const publicKey = toWire(keypair.publicKey);
    const keyChanged = relayProfile.publicKey !== publicKey;

    // Might be a restore still in flight, not a confirmed loss — publishing
    // as reset here would be irreversible if so, so this is left
    // unpublished for another chance (the next sign-in, or a scan, either
    // of which can supply the real key before anything commits).
    const ambiguousRestore = created && !!relayProfile.publicKey;
    if (ambiguousRestore) {
      console.warn(
        `publishAccountKeypair: minted a keypair for ${accountId} but left it unpublished — the relay already has a different key on file, and this may just be a restore still in flight.`
      );
      return;
    }
    if (created || keyChanged) {
      await publishPublicKey(publicKey, keyChanged);
    }
  } catch (err) {
    throw new KeypairPublishError(accountId, relayProfile.name, err);
  }
}

/**
 * The only caller that matters right now: by the time sign-in reaches
 * this, saveAuthToken has already landed, so a keypair-specific failure
 * here must not make a sign-in that already succeeded look like it
 * didn't. Anything else thrown (a network error, the relay itself
 * refusing) is a real failure and still propagates.
 */
export async function publishAccountKeypairOrDegrade(accountId: string, keypair: Keypair, created: boolean): Promise<void> {
  try {
    await publishAccountKeypair(accountId, keypair, created);
  } catch (err) {
    if (err instanceof KeypairPublishError) {
      console.error(err.message, err.cause);
      return;
    }
    throw err;
  }
}

export { mintAndSaveAccountKeypair };
