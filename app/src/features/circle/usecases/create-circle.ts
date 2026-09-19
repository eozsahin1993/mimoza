import { Buffer } from 'buffer';

import { bytesToHex } from '@noble/curves/utils.js';

import { generateUUID, hashBytes, sealToPublicKey } from '@/core/crypto/primitives';
import { buildAuthorityKeyClaim, deriveAuthorityKeypair, deriveCircleIdentity, derivePushRoutingId, deriveCircleSealingKeypair } from '@/core/crypto/identity';
import { deriveWriteToken, generateContentKey, hashWriteToken } from '@/features/circle/crypto';
import { getProfile, insertCircle, MemberRoles, recordMemberAddedLocally } from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { recordInManifestBestEffort } from '@/features/account/usecases/account-manifest';
import { compressToThumbnail } from '@/core/photo/image';
import { writeCoverFile } from '@/core/photo/photo-cache';
import { publishCoverPhoto } from '@/features/circle/usecases/publish-cover-photo';
import { bootstrapCircle, appendEntry } from '@/core/services/log-relay';
import { defaultCircleMask } from '@/features/push-notifications/usecases/push-preferences';
import { ensureCircleNotificationChannel } from '@/features/push-notifications/services/channels';
import { saveCircleIdentity, saveCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { getMasterSeed } from '@/core/services/keystore/master-seed';

export type CreateCircleInput = {
  name: string;
  /** Cover photo picked on the create screen, if any. */
  picture?: Uint8Array;
};

/**
 * Creates a circle and makes this device its first member, as `admin`.
 * Two required relay calls, not one: `bootstrapCircle` registers the
 * control state, then `appendEntry` logs
 * the founder's own `member_added` using the token just registered. Both
 * propagate on failure rather than being swallowed — nothing about this
 * circle works until they succeed.
 *
 * Identity, sealing, and authority keys are all seed-derived (recoverable
 * from the phrase alone); the content key is freshly generated and sealed
 * to the founder's own sealing key so it's recoverable from the log too,
 * not just this device's Keychain.
 */
export async function createCircle(input: CreateCircleInput): Promise<{ id: string }> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed yet — onboarding must generate one before any circle exists.');

  const now = Date.now();
  const pushCategoryMask = await defaultCircleMask();
  const circleId = generateUUID();
  const syncId = generateUUID();
  const memberId = generateUUID();
  const identity = deriveCircleIdentity(masterSeed, circleId);
  const sealingKeypair = deriveCircleSealingKeypair(masterSeed, circleId);
  const authorityKeypair = deriveAuthorityKeypair(masterSeed, circleId);
  const contentKey = generateContentKey();
  const writeToken = deriveWriteToken(contentKey);

  await bootstrapCircle(syncId, authorityKeypair.publicKey, hashWriteToken(writeToken));

  const profile = await getProfile();

  // Best-effort, same as requestToJoin's own thumbnail — a compression
  // failure shouldn't block creating the circle itself; other devices
  // just show the hatch placeholder for this member instead.
  let pictureThumbnail: string | undefined;
  if (profile?.picture) {
    try {
      pictureThumbnail = Buffer.from(await compressToThumbnail(profile.picture)).toString('base64');
    } catch (err) {
      console.error('Failed to compress profile picture for member_added', err);
    }
  }

  const memberAddedEntry = buildAndEncryptLogEntry(
    EntryTypes.MEMBER_ADDED,
    {
      identityPublicKey: bytesToHex(identity.publicKey),
      encPublicKey: bytesToHex(sealingKeypair.publicKey),
      name: profile?.name ?? '',
      role: MemberRoles.admin,
      keyVersion: 1,
      sealedContentKey: bytesToHex(sealToPublicKey(contentKey, sealingKeypair.publicKey)),
      picture: pictureThumbnail,
      createdAt: now,
      // On the entry, not just the local row: a joiner walks meta from
      // epoch 0 and this is the only place they learn the founder's.
      pushRoutingId: derivePushRoutingId(masterSeed, circleId),
      ...buildAuthorityKeyClaim(masterSeed, circleId, bytesToHex(identity.publicKey)),
    },
    identity,
    contentKey
  );
  await appendEntry(syncId, 'meta', generateUUID(), memberAddedEntry, 1, writeToken, identity.publicKey);

  await saveCircleIdentity(circleId, { ...identity, memberId });
  await saveCircleKeyMap(circleId, { 1: contentKey });

/**
 * Cover bytes are written to the photo cache the moment they're known, so
 * the circle list only ever hands `expo-image` a `file://` path. Without
 * this the list pays the first read itself, and reading a cover out of
 * SQLite is dear: the driver returns it as `{data: number[]}`, so a 200KB
 * picture arrives as one boxed JS number per byte. The cache is still
 * disposable — resolveCoverUri re-reads if the OS clears it.
 */
  let pictureHash: string | null = null;
  if (input.picture) {
    pictureHash = hashBytes(input.picture);
    writeCoverFile(circleId, input.picture, pictureHash);
  }

  await insertCircle({
    id: circleId,
    name: input.name,
    picture: input.picture ?? null,
    pictureHash,
    syncId,
    pushCategoryMask,
    createdAt: now,
    leftAt: null,
    // Deliberately *not* 1, though this device wrote epoch 1 itself. The
    // roster it already has, but the `member_events` row behind it only
    // exists once the entry is applied, and skipping it is why the
    // founder alone never saw "created this circle" in their own feed.
    metaCursor: 0,
    contentCursor: 0,
    lastViewedAt: now,
  });

  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(identity.publicKey),
    joinedAt: now,
    profile: {
      encPublicKey: bytesToHex(sealingKeypair.publicKey),
      memberId,
      pushRoutingId: derivePushRoutingId(masterSeed, circleId),
      authorityPublicKey: bytesToHex(authorityKeypair.publicKey),
      role: MemberRoles.admin,
      name: profile?.name ?? '',
      picture: profile?.picture ?? null,
    },
  });

  await ensureCircleNotificationChannel(circleId, input.name);

  // The picture above is this device's copy. Without this, a cover chosen
  // at creation never leaves the phone that chose it — only the details
  // screen's "change cover" ever uploaded one.
  if (input.picture) {
    try {
      await publishCoverPhoto(circleId, input.picture);
    } catch (err) {
      console.error('Failed to upload the cover photo at creation', err);
    }
  }

  await recordInManifestBestEffort();

  return { id: circleId };
}
