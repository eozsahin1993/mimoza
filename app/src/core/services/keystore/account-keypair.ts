import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { generateEphemeralKeypair } from '@/core/crypto/primitives';
import { deleteSecret, getSecret, setSecret } from '@/core/services/keystore/store';
import type { Keypair } from '@/core/crypto/primitives';

/**
 * The one keypair this account has. Members seal a circle's content keys
 * to its public half, and this device opens them with the private half.
 *
 * Losing it is survivable but slow: the device publishes a new public key
 * with `reset`, and another member's device reseals every circle. So the
 * private half is stored where the platform will carry it to a new phone
 * — iCloud Keychain on iOS, and Block Store on Android once that is
 * wired. It never leaves the device by any other route, and the relay
 * never sees it.
 */
const STORAGE_KEY = 'account_keypair';

export async function getAccountKeypair(): Promise<Keypair | null> {
  const raw = await getSecret(STORAGE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { publicKey: string; secretKey: string };
  return { publicKey: hexToBytes(parsed.publicKey), secretKey: hexToBytes(parsed.secretKey) };
}

/**
 * Returns the stored keypair, minting one the first time. `created` is
 * what sign-in uses to decide whether to publish the public half as an
 * ordinary first key or as a reset, which is the difference between
 * "here is my key" and "every circle I am in is now unreadable".
 */
export async function ensureAccountKeypair(): Promise<{ keypair: Keypair; created: boolean }> {
  const existing = await getAccountKeypair();
  if (existing) return { keypair: existing, created: false };

  const keypair = generateEphemeralKeypair();
  await saveAccountKeypair(keypair);
  return { keypair, created: true };
}

export async function saveAccountKeypair(keypair: Keypair): Promise<void> {
  await setSecret(
    STORAGE_KEY,
    JSON.stringify({ publicKey: bytesToHex(keypair.publicKey), secretKey: bytesToHex(keypair.secretKey) })
  );
}

/** Signing out of the account, and the only thing that discards the key. */
export async function forgetAccountKeypair(): Promise<void> {
  await deleteSecret(STORAGE_KEY);
}
