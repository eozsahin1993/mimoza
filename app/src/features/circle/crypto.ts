import { randomBytes } from '@noble/curves/utils.js';

/**
 * A fresh content key: 32 random bytes, one per version. Every member
 * holding that version has the same key, sealed to each of them
 * individually — so excluding someone from the *next* version's seals is
 * what revokes them, not any property of the key itself.
 *
 * Made at two moments only: founding a circle, and rotating after a
 * departure.
 */
export function generateContentKey(): Uint8Array {
  return randomBytes(32);
}
