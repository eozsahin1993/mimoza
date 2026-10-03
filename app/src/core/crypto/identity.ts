import { x25519 } from '@noble/curves/ed25519.js';
import { concatBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import type { Keypair } from '@/core/crypto/primitives';

const CIRCLE_SEALING_KEY_DOMAIN = new TextEncoder().encode('circle-identity-seal');

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
