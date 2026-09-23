import { applyCircle, applyRoster, getProfile } from '@/data/db';
import { toWire } from '@/core/crypto/content';
import { sealToPublicKey } from '@/core/crypto/primitives';
import { generateContentKey } from '@/features/circle/crypto';
import { getAccountKeypair } from '@/core/services/keystore/account-keypair';
import { saveCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { createCircle as createOnRelay } from '@/features/circle/services/circle-relay';
import { setCoverPhoto } from '@/features/circle/usecases/set-cover-photo';

export type CreateCircleInput = {
  name: string;
  /** Cover photo picked on the create screen, if any. */
  picture?: Uint8Array;
};

/**
 * Makes a circle and this account its first admin. The content key is
 * sealed to this account before anything is sent: the relay only ever
 * holds the sealed copy, so a founder who skipped it would own a circle
 * they could not read.
 */
export async function createCircle(input: CreateCircleInput): Promise<{ id: string }> {
  const profile = await getProfile();
  if (!profile) throw new Error('No profile on this device.');
  const keypair = await getAccountKeypair();
  if (!keypair) throw new Error('No account keypair on this device.');

  const contentKey = generateContentKey();
  const sealed = toWire(sealToPublicKey(contentKey, keypair.publicKey));

  const membership = await createOnRelay(input.name, sealed);
  await saveCircleKeyMap(membership.circleId, { [membership.keyVersion]: contentKey });

  // Straight through, not rebuilt: role and notify level are the relay's
  // to decide.
  const now = Date.now();
  await applyCircle(membership, now);

  // Not left to the next sync: it only refetches the roster when
  // rosterVersion moves, and the line above just recorded the current
  // one — so the circle would have no members until something else
  // changed it.
  await applyRoster(
    membership.circleId,
    [
      {
        circleId: membership.circleId,
        accountId: profile.accountId,
        name: profile.name,
        publicKey: toWire(keypair.publicKey),
        role: membership.role,
        joinedAt: now,
      },
    ],
    now
  );

  // Needs the circle to exist to upload against, and a circle with no
  // cover is still a circle.
  if (input.picture) {
    await setCoverPhoto(membership.circleId, input.picture).catch((err) =>
      console.error(`Failed to set the cover for ${membership.circleId}`, err)
    );
  }

  return { id: membership.circleId };
}
