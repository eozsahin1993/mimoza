import {
  applyComment,
  defer,
  done,
  due,
  dropPendingComment,
  getAttachment,
  retryLater,
  settleReaction,
  type OutboxEntry,
} from '@/data/db';
import { sealContent } from '@/core/crypto/content';
import { encrypt } from '@/core/crypto/primitives';
import { reactionTag } from '@/core/crypto/reaction-tags';
import { BlobPaths, getUploadTarget, uploadBlob } from '@/core/services/blob-relay';
import { BlobAlreadyExistsError, NetworkUnreachableError } from '@/core/services/relay-errors';
import { getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { applyPostEntry } from '@/core/sync/entry-handlers/post';
import { entryContext, type EntryContext } from '@/core/sync/entry-handlers/types';
import {
  addComment,
  deleteComment,
  deletePost,
  putPost,
  react,
  setVisibility,
  unreact,
  type Entry,
} from '@/features/post/services/post-relay';

/** What each op carries, sealed at send time rather than at queue time. */
type PostPlaintext = { caption: string; createdAt: number; photoHash: string; visibility: string };
type CommentPlaintext = { body: string; createdAt: number };
type ReactionPlaintext = { emoji: string };
type VisibilityPlaintext = { visibility: string };

/**
 * Sends one queued write and returns the post it changed. Every relay
 * write answers with the post's fresh state in the same shape a walk
 * carries, so the device that made the change replaces its own copy
 * immediately rather than waiting for the next pass.
 *
 * Content is sealed here, not when the row was queued: a key rotation in
 * between would otherwise make the write stale, and the relay refuses a
 * version that is not current.
 */
async function send(
  ctx: EntryContext,
  entry: OutboxEntry,
  key: { version: number; key: Uint8Array }
): Promise<Entry> {
  const plaintext = JSON.parse(entry.plaintext) as Record<string, unknown>;

  switch (entry.op) {
    case 'post': {
      const content = plaintext as PostPlaintext;
      const postId = entry.postId ?? entry.entryId;
      if (!postId) throw new Error('A queued post has no id.');
      // Bytes before the row: a crash in between leaves an unreferenced
      // blob, which the circle's deletion sweeps. The other order leaves
      // a post pointing at nothing.
      await uploadPhoto(ctx.circleId, postId, key.key);
      const { visibility, ...sealed } = content;
      return putPost(ctx.circleId, {
        entryId: postId,
        keyVersion: key.version,
        ciphertext: sealContent(sealed, key.key),
        hasBlob: true,
        visibility,
      });
    }
    case 'comment': {
      const content = plaintext as CommentPlaintext;
      if (!entry.postId || !entry.entryId) throw new Error('A queued comment has no post or id.');
      const post = await addComment(ctx.circleId, entry.postId, {
        commentId: entry.entryId,
        keyVersion: key.version,
        ciphertext: sealContent(content, key.key),
      });
      // The relay confirms it now whether or not it made the preview,
      // which is what clears the row's pending flag.
      await applyComment({
        id: entry.entryId,
        postId: entry.postId,
        circleId: ctx.circleId,
        authorId: ctx.accountId,
        body: content.body,
        createdAt: content.createdAt,
      });
      return post;
    }
    case 'reaction': {
      const { emoji } = plaintext as ReactionPlaintext;
      if (!entry.postId) throw new Error('A queued reaction has no post.');
      if (!ctx.tagKey) throw new Error('No reaction key for this circle on this device.');
      const tag = reactionTag(emoji, ctx.tagKey);
      const post = await react(ctx.circleId, entry.postId, {
        tag,
        keyVersion: key.version,
        ciphertext: sealContent({ emoji }, key.key),
      });
      await settleReaction(entry.postId, ctx.accountId, tag);
      return post;
    }
    case 'unreact': {
      // The tag is the row's, not derived here: it was made under
      // whichever key version was current then, and a rotation since
      // would give a different one for the same emoji.
      if (!entry.postId || !entry.entryId) throw new Error('A queued unreaction has no post or tag.');
      const post = await unreact(ctx.circleId, entry.postId, entry.entryId);
      await settleReaction(entry.postId, ctx.accountId, entry.entryId);
      return post;
    }
    case 'delete_post': {
      if (!entry.postId) throw new Error('A queued deletion has no post.');
      return deletePost(ctx.circleId, entry.postId);
    }
    case 'delete_comment': {
      if (!entry.postId || !entry.entryId) throw new Error('A queued comment deletion has no post or id.');
      const post = await deleteComment(ctx.circleId, entry.postId, entry.entryId);
      await dropPendingComment(entry.entryId);
      return post;
    }
    case 'set_visibility': {
      const { visibility } = plaintext as VisibilityPlaintext;
      if (!entry.postId) throw new Error('A queued visibility change has no post.');
      return setVisibility(ctx.circleId, entry.postId, visibility);
    }
    default:
      // Not a typo the compiler would catch — a row a newer build
      // queued and this one was downgraded past.
      throw new Error(`Unknown outbox op: ${entry.op}`);
  }
}

/**
 * Already-uploaded is what a retry sees once the earlier attempt landed.
 *
 * Encrypted here, under the key current at drain time — not when the
 * post was queued, same reasoning as the caption: a rotation in between
 * must not leave the blob sealed under a version older than the entry
 * that names it. The local copy stays plaintext; only the network-bound
 * copy is ever sealed.
 */
async function uploadPhoto(circleId: string, postId: string, key: Uint8Array): Promise<void> {
  const attachment = await getAttachment(circleId, postId);
  if (!attachment?.bytes) throw new Error('A queued post has no photo on this device.');
  try {
    await uploadBlob(await getUploadTarget(circleId, BlobPaths.photo(postId)), encrypt(attachment.bytes, key));
  } catch (err) {
    if (!(err instanceof BlobAlreadyExistsError)) throw err;
  }
}

/** What an unreachable relay waits, matching the scheduler's own cadence. */
const OFFLINE_RETRY_MS = 30_000;

/**
 * Sends everything due, in the order it was queued, stopping at the
 * first failure rather than reordering around it — a comment must not
 * overtake its post.
 *
 * A failure the relay returned is retried with a growing delay until the
 * row's budget runs out, at which point it is marked failed and surfaces
 * as a banner; one that never reached the relay waits without spending
 * an attempt, so being offline can never fail a write. Only
 * one drain runs per circle: drains are triggered from several
 * uncoordinated places, and two would push the same rows twice.
 */
const inFlight = new Map<string, Promise<void>>();

export function drainOutbox(circleId: string): Promise<void> {
  const running = inFlight.get(circleId);
  if (running) return running;

  const drain = pushDue(circleId).finally(() => inFlight.delete(circleId));
  inFlight.set(circleId, drain);
  return drain;
}

async function pushDue(circleId: string): Promise<void> {
  const ctx = await entryContext(circleId);
  const key = await getCurrentContentKey(circleId);
  if (!ctx || !key) return;

  for (const entry of await due(circleId, Date.now())) {
    try {
      await applyPostEntry(ctx, await send(ctx, entry, key));
      await done(entry.seq);
    } catch (err) {
      // Never reaching the relay is not the write's fault. Counting it
      // would put a post made on a plane in the failed banner inside
      // half a minute, with nothing wrong with the post.
      if (err instanceof NetworkUnreachableError) {
        await defer(entry.seq, Date.now() + OFFLINE_RETRY_MS, String(err));
        return;
      }
      const attempts = entry.attempts + 1;
      // 2s, 4s, 8s, 16s — then the row's budget is spent and it waits
      // for someone to look at the banner.
      await retryLater(entry.seq, attempts, Date.now() + 2 ** attempts * 1000, String(err));
      return;
    }
  }
}
