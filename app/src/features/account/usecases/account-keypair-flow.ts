import { toWire } from '@/core/crypto/content';
import { getAccountKeypair, mintAndSaveAccountKeypair } from '@/core/services/keystore/account-keypair';
import { getProfile as getRelayProfile, publishPublicKey } from '@/features/account/services/account-relay';
import type { Keypair } from '@/core/crypto/primitives';

/**
 * What sign-in does next with the account keypair. A mismatch is usually a
 * key an earlier sign-in minted and held back (see ambiguousRestore), so it
 * is published rather than asked about. With no key on this device, a name
 * on the relay is what tells a returning account, which needs recovery,
 * from a new one, which mints.
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
  const keypair = await getAccountKeypair(accountId, { waitForSync: !!relayProfile.publicKey });
  if (keypair) {
    return toWire(keypair.publicKey) === relayProfile.publicKey
      ? { kind: KeypairStatuses.IN_SYNC }
      : { kind: KeypairStatuses.KEYPAIR_MISMATCH, keypair };
  }
  return relayProfile.name ? { kind: KeypairStatuses.NEEDS_RECOVERY } : { kind: KeypairStatuses.FRESH_SIGNUP };
}

/** Lets sign-in tell its own failure apart from a key that didn't publish after the session was saved. */
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
 * Publishes a keypair the caller already holds. It goes up as a reset only
 * when it replaces a different key on the relay, not whenever it was just
 * minted: a first signup mints too, with nothing to lose.
 */
export async function publishAccountKeypair(accountId: string, keypair: Keypair, created: boolean): Promise<void> {
  const relayProfile = await getRelayProfile();
  try {
    const publicKey = toWire(keypair.publicKey);
    const keyChanged = relayProfile.publicKey !== publicKey;

    // Possibly a restore still in flight rather than a lost key. A reset can't
    // be undone, so this waits for the next sign-in or a scan to settle it.
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
 * For sign-in, whose session is already saved by now: a key that fails to
 * publish is logged rather than thrown, so the sign-in doesn't look failed.
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
