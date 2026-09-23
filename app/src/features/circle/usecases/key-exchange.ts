import { hexToBytes } from '@noble/curves/utils.js';

import { openSealedBox, sealToPublicKey } from '@/core/crypto/primitives';
import { getAccountKeypair } from '@/core/services/keystore/account-keypair';
import { getCircleKeyMap, saveCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { rewrapKeys, type RosterMember } from '@/features/circle/services/circle-relay';

/**
 * The two sides of a circle's key exchange: taking in the copies sealed
 * to this account, and sealing this device's copies to a member who
 * replaced their keypair.
 *
 * The relay stores every version sealed to each member and can open
 * none of them. Old versions are kept forever — content stays encrypted
 * under whichever key was current when it was written.
 */

/** Sealed copies from the roster, by version. Ones that don't open are skipped rather than failing the sync. */
export async function storeSealedKeys(circleId: string, sealed: Record<string, string>): Promise<void> {
  const keypair = await getAccountKeypair();
  if (!keypair) return;

  const keys = (await getCircleKeyMap(circleId)) ?? {};
  let added = false;
  for (const [version, value] of Object.entries(sealed)) {
    if (keys[Number(version)]) continue;
    try {
      keys[Number(version)] = openSealedBox(new Uint8Array(Buffer.from(value, 'base64')), keypair);
      added = true;
    } catch {
      // Sealed to a keypair this device no longer holds. A member
      // reseals it once they see needsRewrap.
      console.warn(`Could not open key version ${version} for circle ${circleId}`);
    }
  }
  if (added) await saveCircleKeyMap(circleId, keys);
}

/**
 * Reseals every version this device holds to a member who replaced their
 * keypair, which is what clears their `needsRewrap` flag.
 *
 * Any member with the keys can do this, so several may race; the relay
 * takes whichever lands and the rest are harmless repeats.
 */
export async function resealFor(circleId: string, member: RosterMember): Promise<void> {
  if (!member.publicKey) return;
  const keys = await getCircleKeyMap(circleId);
  if (!keys) return;

  const publicKey = hexToBytes(member.publicKey);
  const sealed: Record<string, string> = {};
  for (const [version, key] of Object.entries(keys)) {
    sealed[version] = Buffer.from(sealToPublicKey(key, publicKey)).toString('base64');
  }
  if (Object.keys(sealed).length === 0) return;

  await rewrapKeys(circleId, member.accountId, sealed);
}
