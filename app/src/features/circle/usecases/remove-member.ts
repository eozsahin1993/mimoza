import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { getCircle, getCircleMembers, recordMemberRemovedLocally } from '@/data/db';
import { requireAdminPublicKey } from '@/features/invite/usecases/invite-to-circle';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { generateUUID, sealToPublicKey, sign } from '@/core/crypto/primitives';
import { deriveAuthorityKeypair } from '@/core/crypto/identity';
import { deriveRotateMessage } from '@/core/crypto/signed-messages';
import { deriveWriteToken, generateContentKey, hashWriteToken } from '@/features/circle/crypto';
import { addCircleKeyVersion, getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { appendEntry, rotateLog } from '@/core/services/log-relay';
import { pullMeta } from '@/core/sync/pull-log';
import { resyncPushIfStale } from '@/features/push-notifications/usecases/push-preferences';

/**
 * Removes a member and rotates the content key — admin only. Roster
 * removal alone doesn't revoke anything; the removed device would still
 * hold every key it ever had, so this also generates `K_{v+1}` and seals
 * it to every *other* current member's `encPublicKey`. The removed member
 * gets no wrap — that omission is the revocation.
 *
 * Both relay calls are direct and synchronous, not queued through the
 * outbox: `rotateLog` is the relay's dedicated capability-gated path for
 * this (see relay.ts) — it swaps the server's stored write-token hash
 * atomically with the append, which the generic outbox/appendEntry path
 * has no way to do. Pushing `member_removed` first, awaited, before
 * calling `rotateLog` is what guarantees it lands at a lower epoch than
 * its own rotation. Local state (`recordMemberRemovedLocally`/`addCircleKeyVersion`)
 * only updates once both calls succeed — a failure between them leaves an
 * orphaned `member_removed` with no rotation yet, which a retry heals on
 * its own (a second `member_removed` for the same target is a harmless,
 * idempotent no-op at apply time).
 *
 * Doesn't close the propagation-lag window: a remaining member's device
 * that hasn't yet synced this rotation still only has the old key. See
 * the plan's "Named risk: removal has a propagation-lag window."
 */
export async function removeMember(circleId: string, identityPublicKey: string): Promise<void> {
  const ownPublicKey = await requireAdminPublicKey(circleId, 'Only an admin can remove a member.');
  if (identityPublicKey === ownPublicKey) {
    throw new Error('Use "Leave" to remove yourself from a circle.');
  }

  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');

  // Catch up first, same reason as approveJoinRequest's own pullMeta call:
  // a stale roster here means skipping a just-joined member's wrap, or
  // picking a version that collides with a rotation not yet seen.
  await pullMeta(circleId);

  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  // getCircleMembers already excludes anyone already removed.
  const remaining = (await getCircleMembers(circleId)).filter((member) => member.identityPublicKey !== identityPublicKey);

  const newVersion = current.version + 1;
  const newKey = generateContentKey();
  const wraps: Record<string, string> = {};
  for (const member of remaining) {
    wraps[member.identityPublicKey] = bytesToHex(sealToPublicKey(newKey, hexToBytes(member.encPublicKey)));
  }

  // Carried on the entry for the same reason member_added carries it —
  // so every device dates this removal identically instead of stamping
  // its own receipt time when it replays meta.
  const removedAt = Date.now();
  const removedEntry = buildAndEncryptLogEntry(EntryTypes.MEMBER_REMOVED, { identityPublicKey, createdAt: removedAt }, identity, current.key);
  const rotationEntry = buildAndEncryptLogEntry(EntryTypes.KEY_ROTATION, { version: newVersion, wraps }, identity, current.key);

  const currentWriteToken = deriveWriteToken(current.key);
  const newWriteTokenHash = hashWriteToken(deriveWriteToken(newKey));
  const authorityKeypair = deriveAuthorityKeypair(masterSeed, circleId);
  const rotationEntryId = generateUUID();
  const signature = sign(deriveRotateMessage(circle.syncId, rotationEntryId, newWriteTokenHash), authorityKeypair.secretKey);

  // Direct rather than through the outbox — the only reason is the
  // rotation below. It swaps the relay's stored write-token hash, so
  // `currentWriteToken` dies the moment it lands and the two calls have
  // to be one sequence, not two entries a drain pushes minutes apart.
  // leave-circle.ts queues the same entry type because it doesn't rotate.
  await appendEntry(circle.syncId, 'meta', generateUUID(), removedEntry, current.version, currentWriteToken, identity.publicKey);
  await rotateLog(circle.syncId, rotationEntryId, rotationEntry, current.version, currentWriteToken, newWriteTokenHash, authorityKeypair.publicKey, signature);

  await recordMemberRemovedLocally({ circleId, subjectPublicKey: identityPublicKey, removedAt });
  await addCircleKeyVersion(circleId, newVersion, newKey);
  // Now rather than on the next sync pass: until it lands, the member just
  // removed can still push to this account and nobody else can.
  await resyncPushIfStale(circleId).catch((err) => console.error('Failed to re-sync notifications after removal', err));
}
