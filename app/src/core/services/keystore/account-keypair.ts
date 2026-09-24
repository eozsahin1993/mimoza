import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { generateEphemeralKeypair } from '@/core/crypto/primitives';
import { deleteSyncedSecret, getSyncedSecret, setSyncedSecret } from '@/core/services/keystore/synced-store';
import type { Keypair } from '@/core/crypto/primitives';

/**
 * The one keypair each account has. Members seal a circle's content keys
 * to its public half, and this device opens them with the private half.
 *
 * Losing it is survivable but slow: the device publishes a new public key
 * with `reset`, and another member's device reseals every circle. So the
 * private half is stored where the platform will carry it to a new phone
 * — iCloud Keychain on iOS, Block Store on Android. It never leaves the
 * device by any other route, and the relay never sees it.
 *
 * Scoped by account id: the synced store is keyed to the device's own
 * iCloud/Google account, not to whichever Mimoza account is signed in,
 * so a single unscoped slot would hand account B a keypair minted for
 * account A the moment someone signed out of one and into the other on
 * the same device — and with it, the ability to keep decrypting content
 * sealed for account A in any circle it later joined.
 */
function storageKey(accountId: string): string {
  return `account_keypair:${accountId}`;
}

export async function getAccountKeypair(accountId: string): Promise<Keypair | null> {
  const raw = await getSyncedSecret(storageKey(accountId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { publicKey: string; secretKey: string };
  return { publicKey: hexToBytes(parsed.publicKey), secretKey: hexToBytes(parsed.secretKey) };
}

/**
 * Returns the stored keypair, minting one the first time. `created` is
 * what sign-in uses to decide whether to publish the public half as an
 * ordinary first key or as a reset, which is the difference between
 * "here is my key" and "every circle I am in is now unreadable".
 *
 * synced-store's retries shrink but do not close the window where a
 * fresh restore reads as `created: true` before iCloud has actually
 * delivered the real key — whatever calls this first (sign-in) should
 * treat a reset right after restore as a possibility to confirm, not
 * a certainty to act on silently.
 */
export async function ensureAccountKeypair(accountId: string): Promise<{ keypair: Keypair; created: boolean }> {
  const existing = await getAccountKeypair(accountId);
  if (existing) return { keypair: existing, created: false };

  const keypair = generateEphemeralKeypair();
  await saveAccountKeypair(accountId, keypair);
  return { keypair, created: true };
}

export async function saveAccountKeypair(accountId: string, keypair: Keypair): Promise<void> {
  await setSyncedSecret(
    storageKey(accountId),
    JSON.stringify({ publicKey: bytesToHex(keypair.publicKey), secretKey: bytesToHex(keypair.secretKey) })
  );
}

/** Signing out of the account, and the only thing that discards the key. */
export async function forgetAccountKeypair(accountId: string): Promise<void> {
  await deleteSyncedSecret(storageKey(accountId));
}
