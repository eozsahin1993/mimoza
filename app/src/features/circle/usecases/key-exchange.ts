import { fromWire, toWire } from '@/core/crypto/content';
import { openSealedBox, sealToPublicKey } from '@/core/crypto/primitives';
import { getAccountKeypair } from '@/core/services/keystore/account-keypair';
import { getCircleKeyMap, saveCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { rewrapKeys, type RosterMember } from '@/features/circle/services/circle-relay';

/**
 * A circle's key exchange. The relay stores every version sealed to each
 * member and can open none of them; old versions are kept forever, since
 * content stays under whichever key was current when it was written.
 */

/**
 * Sealed copies from the roster, by version. One that will not open is
 * skipped rather than failing the sync — but no local keypair at all
 * throws, rather than silently doing nothing: sync-circles.ts only
 * retries this on the next roster/key version change, so silently
 * succeeding here would leave a circle's content permanently unsynced
 * on a device that has nothing yet to open sealed keys with, instead of
 * retried on the very next pass the way any other failure here is.
 */
export async function storeSealedKeys(circleId: string, sealed: Record<string, string>, accountId: string): Promise<void> {
  const keypair = await getAccountKeypair(accountId);
  if (!keypair) throw new Error(`No account keypair on this device — cannot open sealed keys for circle ${circleId}`);

  const keys = (await getCircleKeyMap(circleId)) ?? {};
  let added = false;
  for (const [version, value] of Object.entries(sealed)) {
    if (keys[Number(version)]) continue;
    try {
      keys[Number(version)] = openSealedBox(fromWire(value), keypair);
      added = true;
    } catch {
      // Sealed to a keypair this device replaced; a member reseals it
      // once they see needsRewrap.
      console.warn(`Could not open key version ${version} for circle ${circleId}`);
    }
  }
  if (added) await saveCircleKeyMap(circleId, keys);
}

/**
 * Reseals every version to a member who replaced their keypair, clearing
 * their `needsRewrap`. Any member holding the keys can, so several race;
 * the relay takes whichever lands.
 */
export async function resealFor(circleId: string, member: RosterMember): Promise<void> {
  if (!member.publicKey) return;
  const keys = await getCircleKeyMap(circleId);
  if (!keys) return;

  const publicKey = fromWire(member.publicKey);
  const sealed: Record<string, string> = {};
  for (const [version, key] of Object.entries(keys)) {
    sealed[version] = toWire(sealToPublicKey(key, publicKey));
  }
  if (Object.keys(sealed).length === 0) return;

  await rewrapKeys(circleId, member.accountId, sealed);
}

/**
 * One new key sealed to each member staying, for a rotation.
 *
 * Keyed by account — the opposite of `storeSealedKeys` and `resealFor`,
 * which are keyed by version, though the relay calls both `sealed`. A
 * rotation is "one key, everyone who stays"; a reseal is "every version,
 * one person".
 */
export function sealForEach(members: RosterMember[], key: Uint8Array): Record<string, string> {
  const sealed: Record<string, string> = {};
  for (const member of members) {
    // Skipping one would make the relay refuse the whole rotation, with
    // nothing naming who was missed — so fail here where it can be said.
    if (!member.publicKey) {
      throw new Error(`No published key for ${member.accountId}, so the key cannot be rotated yet.`);
    }
    sealed[member.accountId] = toWire(sealToPublicKey(key, fromWire(member.publicKey)));
  }
  return sealed;
}
