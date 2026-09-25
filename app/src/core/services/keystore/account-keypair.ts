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
  return `account_keypair.${accountId}`;
}

/**
 * A short, safe log fingerprint — public keys aren't secret (they're
 * published to the relay), and unlike a certificate's fixed header, a
 * raw X25519 key has no common prefix, so this actually distinguishes
 * one keypair from another at a glance in logcat/Metro.
 */
function fingerprint(publicKey: Uint8Array): string {
  return bytesToHex(publicKey).slice(0, 8);
}

export async function getAccountKeypair(accountId: string): Promise<Keypair | null> {
  const raw = await getSyncedSecret(storageKey(accountId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { publicKey: string; secretKey: string };
  const keypair = { publicKey: hexToBytes(parsed.publicKey), secretKey: hexToBytes(parsed.secretKey) };
  console.log(`[account-keypair] read ${accountId}: ${fingerprint(keypair.publicKey)}`);
  return keypair;
}

/**
 * Always mints a fresh keypair and saves it, overwriting whatever was
 * there.
 */
export async function mintAndSaveAccountKeypair(accountId: string): Promise<Keypair> {
  const keypair = generateEphemeralKeypair();
  await saveAccountKeypair(accountId, keypair);
  return keypair;
}

export async function saveAccountKeypair(accountId: string, keypair: Keypair): Promise<void> {
  console.log(`[account-keypair] save ${accountId}: ${fingerprint(keypair.publicKey)}`);
  await setSyncedSecret(
    storageKey(accountId),
    JSON.stringify({ publicKey: bytesToHex(keypair.publicKey), secretKey: bytesToHex(keypair.secretKey) })
  );
}

/** Signing out of the account, and the only thing that discards the key. */
export async function forgetAccountKeypair(accountId: string): Promise<void> {
  await deleteSyncedSecret(storageKey(accountId));
}
