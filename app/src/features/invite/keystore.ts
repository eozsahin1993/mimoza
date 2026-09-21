import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { deleteSecret, getSecret, setSecret } from '@/core/services/keystore/store';
import type { Keypair } from '@/core/crypto/primitives';

function pendingJoinKeypairStorageKey(requestId: string) {
  return `pending_join_keypair_${requestId}`;
}

/**
 * Persists the one-time ephemeral keypair for an outstanding join request —
 * the secret half of the sealed-box handshake, so it belongs in the
 * Keychain like every other secret key here, not in the local
 * `pendingJoinRequests` row (which only holds the public half).
 */
export async function savePendingJoinKeypair(requestId: string, keypair: Keypair): Promise<void> {
  const value = JSON.stringify({
    publicKey: bytesToHex(keypair.publicKey),
    secretKey: bytesToHex(keypair.secretKey),
  });
  await setSecret(pendingJoinKeypairStorageKey(requestId), value);
}

/** Reads a pending join request's ephemeral keypair back, or null if none is stored. */
export async function getPendingJoinKeypair(requestId: string): Promise<Keypair | null> {
  const raw = await getSecret(pendingJoinKeypairStorageKey(requestId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { publicKey: string; secretKey: string };
  return { publicKey: hexToBytes(parsed.publicKey), secretKey: hexToBytes(parsed.secretKey) };
}

/** Removes a pending join request's ephemeral keypair — once the request completes or is abandoned. */
export async function deletePendingJoinKeypair(requestId: string): Promise<void> {
  await deleteSecret(pendingJoinKeypairStorageKey(requestId));
}

function inviteJoinRequestKeyStorageKey(pushRoutingId: string) {
  return `invite_join_request_key_${pushRoutingId}`;
}

/**
 * An invite's join-request key, for the iOS notification extension to read
 * request pushes with (it can't open SQLite, where the code lives). The key
 * rather than the code: the key only reads requests, the code could send them.
 */
export async function saveInviteJoinRequestKey(pushRoutingId: string, key: Uint8Array): Promise<void> {
  await setSecret(inviteJoinRequestKeyStorageKey(pushRoutingId), bytesToHex(key));
}

export async function deleteInviteJoinRequestKey(pushRoutingId: string): Promise<void> {
  await deleteSecret(inviteJoinRequestKeyStorageKey(pushRoutingId));
}
