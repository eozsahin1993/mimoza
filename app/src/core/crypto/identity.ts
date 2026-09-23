import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, concatBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { sign } from '@/core/crypto/primitives';
import type { Keypair } from '@/core/crypto/primitives';
import { deriveAuthorityKeyProofMessage } from '@/core/crypto/signed-messages';

const CIRCLE_SEALING_KEY_DOMAIN = new TextEncoder().encode('circle-identity-seal');
const AUTHORITY_KEY_DOMAIN = new TextEncoder().encode('token-authority');

/**
 * Derives a circle's sealing keypair (X25519), the companion to
 * `deriveCircleIdentity` — used to seal content-key wraps to this member
 * (see `sealToPublicKey`). A different HKDF domain, deliberately: never
 * derive one key type from the other's raw seed.
 */
export function deriveCircleSealingKeypair(masterSeed: Uint8Array, circleId: string): Keypair {
  const seed = hkdf(sha256, masterSeed, undefined, concatBytes(CIRCLE_SEALING_KEY_DOMAIN, new TextEncoder().encode(circleId)), 32);
  return x25519.keygen(seed);
}

/**
 * Derives an admin's authority keypair (Ed25519). Signs control-plane
 * operations (rotating the write token, changing the authority set) that
 * the relay itself verifies, unlike the circle identity above, which only
 * clients verify. Cheap to derive for a non-admin too — it's just never
 * registered with the relay for them.
 */
export function deriveAuthorityKeypair(masterSeed: Uint8Array, circleId: string): Keypair {
  const seed = hkdf(sha256, masterSeed, undefined, concatBytes(AUTHORITY_KEY_DOMAIN, new TextEncoder().encode(circleId)), 32);
  return ed25519.keygen(seed);
}

/**
 * This circle's authority public key plus the proof its owner holds it —
 * the pair every entry that publishes a key must carry. See
 * `deriveAuthorityKeyProofMessage`.
 */
export type AuthorityKeyClaim = { authorityPublicKey: string; authorityKeyProof: string };

export function buildAuthorityKeyClaim(masterSeed: Uint8Array, circleId: string, identityPublicKey: string): AuthorityKeyClaim {
  const keypair = deriveAuthorityKeypair(masterSeed, circleId);
  return {
    authorityPublicKey: bytesToHex(keypair.publicKey),
    authorityKeyProof: bytesToHex(sign(deriveAuthorityKeyProofMessage(identityPublicKey), keypair.secretKey)),
  };
}

const PUSH_ENABLED_DOMAIN = new TextEncoder().encode('push-enabled');

/**
 * This account's push routing id for one circle, hex.
 *
 * Derived from the seed, so every device you own computes the same one and
 * notification preferences need no syncing. Never from `accountId`: the
 * relay knows that and would be able to compute every routing id itself.
 */
export function derivePushRoutingId(masterSeed: Uint8Array, circleId: string): string {
  return bytesToHex(hkdf(sha256, masterSeed, undefined, concatBytes(PUSH_ENABLED_DOMAIN, new TextEncoder().encode(circleId)), 32));
}
