import { bytesToHex, concatBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const PUSH_DEVICE_DOMAIN = new TextEncoder().encode('push-device');
const PUSH_FANOUT_DOMAIN = new TextEncoder().encode('push-fanout');
const PUSH_OWNER_DOMAIN = new TextEncoder().encode('push-owner');

/**
 * This device's id under one routing id, hex.
 *
 * Per routing id, not per device: one value reused across circles would
 * let the relay group your routing ids straight out of the sort key.
 */
export function derivePushDeviceId(deviceSecret: Uint8Array, pushRoutingId: string): string {
  return bytesToHex(hkdf(sha256, deviceSecret, undefined, concatBytes(PUSH_DEVICE_DOMAIN, new TextEncoder().encode(pushRoutingId)), 32));
}

/**
 * The token a sender presents to fan out to a circle —
 * `HKDF(contentKey, "push-fanout")`, same shape as `deriveWriteToken`.
 *
 * Never stored or published: every member derives it from the content key
 * they already hold. Because it follows the *current* key, removing a
 * member revokes their push access through the rotation that already
 * happens.
 */
export function derivePushFanoutToken(contentKey: Uint8Array): Uint8Array {
  return hkdf(sha256, contentKey, undefined, PUSH_FANOUT_DOMAIN, 32);
}

/**
 * `sha256(fanoutToken || pushRoutingId)` — what the relay stores and compares.
 * Salted by routing id: a bare hash would be identical across a circle's
 * rows and cluster its membership out of a table scan.
 */
export function derivePushFanoutHash(fanoutToken: Uint8Array, pushRoutingId: string): Uint8Array {
  return sha256(concatBytes(fanoutToken, new TextEncoder().encode(pushRoutingId)));
}

/**
 * Proves to the relay that a write to a routing id comes from its owner —
 * `HKDF(masterSeed, "push-owner" || pushRoutingId)`. The routing id itself
 * is shared through the roster, so it can't be what authorizes; this is
 * never shared, and every device on the account derives the same one.
 */
export function derivePushOwnerToken(masterSeed: Uint8Array, pushRoutingId: string): Uint8Array {
  return hkdf(sha256, masterSeed, undefined, concatBytes(PUSH_OWNER_DOMAIN, new TextEncoder().encode(pushRoutingId)), 32);
}
