import { getCircle } from '@/data/db';
import { notifyCircleBestEffort } from '@/features/push-notifications/usecases/notify-circle';
import { PushCategories, type PushCategory } from '@/features/push-notifications/usecases/push-categories';
import { EntryTypes } from '@/core/sync/log-entry';
import { timed, timedSync } from '@/core/utils/timing';
import { getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { encrypt, sign } from '@/core/crypto/primitives';
import { deriveAuthorityKeypair } from '@/core/crypto/identity';
import {
  deriveAuthorityChangeMessage,
  deriveDeleteAuthorContentMessage,
  deriveDeleteCircleMessage,
  deriveDeleteEntryMessage,
} from '@/core/crypto/signed-messages';
import { deriveWriteToken } from '@/features/circle/crypto';
import {
  appendEntry,
  changeAuthority,
  deleteAuthorContentOnRelay,
  deleteCircleOnRelay,
  deleteEntryOnRelay,
  type AppendResult,
  type Namespace,
} from '@/core/services/log-relay';
import { getUploadTarget, uploadBlob } from '@/core/services/blob-relay';
import { BlobAlreadyExistsError } from '@/core/services/relay-errors';
import { getPendingOutboxEntries, markOutboxEntrySynced, type OutboxEntry } from '@/data/db';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { getAttachment } from '@/data/db/attachments';

/**
 * Which relay namespace an entry type belongs in. Meta is everything a
 * client needs before it can interpret content at all — identities, keys,
 * roles, circle metadata — so it's rare and synced eagerly in full;
 * content (posts, comments, reactions, tombstones) is voluminous and
 * paged lazily. Must agree with which handler map in sync/entry-handlers
 * reads it; a mismatch means the entry is fetched by the wrong pull and
 * silently discarded as an unknown type, on every device including the
 * author's. See the registry test that enforces the agreement.
 */
const META_ENTRY_TYPES: OutboxEntry['entryType'][] = [
  EntryTypes.MEMBER_ADDED,
  EntryTypes.MEMBER_REMOVED,
  EntryTypes.PROFILE_UPDATE,
  EntryTypes.ROLE_CHANGE,
  EntryTypes.COVER_PHOTO_SET,
  EntryTypes.CIRCLE_RENAMED,
  EntryTypes.PUSH_ENABLED,
  EntryTypes.CIRCLE_DELETED,
  // Replaces MEMBER_REMOVED for this departure — see account-deleted.ts —
  // so it needs the same eager, full sync a roster-terminal entry does.
  EntryTypes.ACCOUNT_DELETED,
  // Never actually queued — rotateLog's atomic write-token swap doesn't
  // fit the generic append path (see remove-member.ts) — but listed so
  // the mapping is right if it ever is.
  EntryTypes.KEY_ROTATION,
];

/**
 * Which entry types are worth interrupting someone for, and as what. Types
 * absent from here never notify — a rename or a key rotation is not news.
 */
const PUSH_CATEGORIES: Partial<Record<OutboxEntry['entryType'], PushCategory>> = {
  [EntryTypes.POST]: PushCategories.newPost,
  [EntryTypes.COMMENT]: PushCategories.comment,
  [EntryTypes.REACTION]: PushCategories.reaction,
  [EntryTypes.MEMBER_ADDED]: PushCategories.memberJoined,
};

export function namespaceFor(entryType: OutboxEntry['entryType']): Namespace {
  return META_ENTRY_TYPES.includes(entryType) ? 'meta' : 'content';
}

/**
 * Pushes every pending outbox entry, strictly in creation order, stopping
 * on the first failure rather than reordering around it. Safe to retry:
 * `appendEntry` is idempotent per entryId, and an entry is only marked
 * synced once its blob (if any) and its append both succeed.
 *
 * For a 'post', the blob is uploaded *before* the entry is appended — a
 * crash in between leaves a harmless orphaned blob rather than a
 * permanent entry pointing at nothing, which an immutable log could
 * never fix. `BlobAlreadyExistsError`
 * on retry means the previous attempt's upload actually succeeded; treat
 * it as done, not as a failure.
 *
 * Only one drain runs per circle at a time. Drains are triggered from
 * several uncoordinated places — creating a post and completing a join
 * both fire one, and every sync pass runs one too — so they genuinely
 * overlap. Two concurrent drains would read the same pending rows and
 * both push them: the relay's per-entryId idempotency means that
 * converges rather than duplicating, but it re-uploads blobs and doubles
 * the requests for nothing. A second caller joins the drain already
 * running instead.
 */
const inFlightDrains = new Map<string, Promise<void>>();
const rerunRequested = new Set<string>();

/**
 * Drains repeatedly until a pass finds nothing new. The loop matters
 * because joining an in-flight drain is not the same as being pushed by
 * it: that drain already read its batch, so anything queued after that
 * read would sit unsent until some later trigger happened along. Posting
 * during a sync pass is the ordinary case, not a rare one — so a caller
 * arriving mid-drain asks for one more pass rather than being quietly
 * dropped.
 */
async function drainUntilQuiet(circleId: string): Promise<void> {
  try {
    do {
      rerunRequested.delete(circleId);
      await pushPendingEntries(circleId);
    } while (rerunRequested.has(circleId));
  } finally {
    rerunRequested.delete(circleId);
    inFlightDrains.delete(circleId);
  }
}

export function drainOutbox(circleId: string): Promise<void> {
  const running = inFlightDrains.get(circleId);
  if (running) {
    rerunRequested.add(circleId);
    return running;
  }

  const drain = drainUntilQuiet(circleId);
  inFlightDrains.set(circleId, drain);
  return drain;
}

/**
 * Pushes a queued post deletion — see `deletePost`. Signs both as this
 * device's own circle identity and as an authority when it has that key,
 * so the relay can accept whichever one actually authorizes it — the
 * relay strips the post and deletes its blob itself, in one call.
 */
async function pushPostDeletion(
  circleId: string,
  syncId: string,
  entry: OutboxEntry,
  keyVersion: number,
  writeToken: Uint8Array
): Promise<AppendResult> {
  const entryId = entry.blobEntryId;
  if (!entryId) throw new Error('Queued post deletion is missing the post it targets.');

  const identity = await getCircleIdentity(circleId);
  const message = deriveDeleteEntryMessage(syncId, entryId, entry.entryId);
  const authorSignature = identity ? sign(message, identity.secretKey) : undefined;
  const masterSeed = await getMasterSeed();
  const authority = masterSeed
    ? (() => {
        const keypair = deriveAuthorityKeypair(masterSeed, circleId);
        return { publicKey: keypair.publicKey, signature: sign(message, keypair.secretKey) };
      })()
    : undefined;

  return deleteEntryOnRelay(syncId, entryId, entry.entryId, entry.encryptedMeta, keyVersion, writeToken, authorSignature, authority);
}

/**
 * Pushes a queued account deletion — see `deleteAccount`. One call erases
 * everything this identity authored in the circle and appends the queued
 * tombstone; signed at drain time with the circle identity, the same key
 * whose content it erases.
 */
async function pushAccountDeletion(
  circleId: string,
  syncId: string,
  entry: OutboxEntry,
  keyVersion: number,
  writeToken: Uint8Array
): Promise<AppendResult> {
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');

  const message = deriveDeleteAuthorContentMessage(syncId, bytesToHex(identity.publicKey), entry.entryId);
  return deleteAuthorContentOnRelay(syncId, identity.publicKey, sign(message, identity.secretKey), {
    entryId: entry.entryId,
    encryptedMeta: entry.encryptedMeta,
    keyVersion,
    writeToken,
  });
}

/**
 * Sends a queued authority change — see `authorityAction` on the outbox
 * schema. The signature is produced here rather than at queue time
 * because it's over the entry id and the target key, and the authority
 * keypair is seed-derived and never stored.
 *
 * Writes nothing locally: the entry this pushes comes straight back on
 * the same sync pass, and its replay is the single writer for both the
 * role and its registration.
 */
async function pushAuthorityChange(
  circleId: string,
  syncId: string,
  entry: OutboxEntry,
  keyVersion: number,
  writeToken: Uint8Array
): Promise<AppendResult> {
  const action = entry.authorityAction;
  const target = entry.authorityTargetKey;
  if (!action || !target) throw new Error('Queued authority change is missing its action or target key.');

  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');
  const keypair = deriveAuthorityKeypair(masterSeed, circleId);

  return changeAuthority({
    syncId,
    entryId: entry.entryId,
    encryptedMeta: entry.encryptedMeta,
    keyVersion,
    writeToken,
    action,
    targetAuthorityPublicKey: hexToBytes(target),
    signerAuthorityPublicKey: keypair.publicKey,
    signature: sign(deriveAuthorityChangeMessage(action, syncId, entry.entryId, target), keypair.secretKey),
  });
}

/**
 * Signed at drain time like an authority change, from a key derived here
 * rather than carried on the queued row — leaving this device's keys the
 * only thing that can authorize its own circle's deletion, even hours
 * after the row was written.
 */
async function pushCircleDeletion(
  circleId: string,
  syncId: string,
  entry: OutboxEntry,
  keyVersion: number,
  writeToken: Uint8Array
): Promise<AppendResult> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');
  const keypair = deriveAuthorityKeypair(masterSeed, circleId);

  return deleteCircleOnRelay({
    syncId,
    entryId: entry.entryId,
    encryptedMeta: entry.encryptedMeta,
    keyVersion,
    writeToken,
    signerAuthorityPublicKey: keypair.publicKey,
    signature: sign(deriveDeleteCircleMessage(syncId, entry.entryId), keypair.secretKey),
  });
}

async function pushPendingEntries(circleId: string): Promise<void> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');
  const writeToken = deriveWriteToken(current.key);
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');

  const pending = await getPendingOutboxEntries(circleId);
  for (const entry of pending) {
    const namespace = namespaceFor(entry.entryType);

    // Only posts carry a blob; comments and reactions are entry-only, so
    // they fall straight through to the append below.
    if (entry.entryType === EntryTypes.POST) {
      // The bytes live on the attachment, not the post — and they're
      // encrypted under the version that attachment recorded, not
      // whatever is current now, so the blob can never disagree with the
      // entry that references it.
      const attachment = await getAttachment(circleId, entry.entryId);
      if (attachment?.bytes) {
        try {
          const target = await getUploadTarget(circle.syncId, entry.entryId, writeToken, identity.publicKey);
          const ciphertext = timedSync(
            `push.encrypt(${Math.round(attachment.bytes.length / 1024)}KB)`,
            () => encrypt(attachment.bytes!, current.key)
          );
          await timed('push.upload', () => uploadBlob(target, ciphertext));
        } catch (err) {
          if (!(err instanceof BlobAlreadyExistsError)) throw err;
        }
      }
    }

    // Some entries can't go down the generic append path, because the relay
    // commits each alongside something else or not at all: an authority
    // change with its set mutation, a deletion with the sweep behind it, a
    // post deletion with the blob delete behind it. Each has an endpoint
    // of its own.
    let result: AppendResult;
    if (entry.authorityAction) {
      result = await pushAuthorityChange(circleId, circle.syncId, entry, current.version, writeToken);
    } else {
      switch (entry.entryType) {
        case EntryTypes.CIRCLE_DELETED:
          result = await pushCircleDeletion(circleId, circle.syncId, entry, current.version, writeToken);
          break;
        case EntryTypes.POST_DELETE:
          result = await pushPostDeletion(circleId, circle.syncId, entry, current.version, writeToken);
          break;
        case EntryTypes.ACCOUNT_DELETED:
          result = await pushAccountDeletion(circleId, circle.syncId, entry, current.version, writeToken);
          break;
        default:
          result = await appendEntry(circle.syncId, namespace, entry.entryId, entry.encryptedMeta, current.version, writeToken, identity.publicKey);
      }
    }
    const { epoch } = result;

    // Notified from here rather than from each usecase: this is the one
    // place that knows an entry actually landed, and it forwards the same
    // ciphertext the log holds, which is all the relay is ever given.
    const category = PUSH_CATEGORIES[entry.entryType];
    if (category !== undefined) {
      notifyCircleBestEffort(circleId, category, current.version, entry.encryptedMeta);
    }

    await markOutboxEntrySynced(entry.sequenceNum, epoch);
  }
}
