import {
  AttachmentKinds,
  clearAttachmentBackoff,
  findCircleSharedWith,
  getFetchableAttachments,
  getFetchableProfilePictures,
  markAttachmentFailed,
  markAttachmentFetched,
  markProfilePictureFailed,
  markProfilePictureFetched,
  type FetchableAttachment,
  type ProfilePicture,
} from '@/data/db';
import { decrypt, hashBytes } from '@/core/crypto/primitives';
import { getAuthToken } from '@/core/services/keystore/auth-token';
import { getCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { writeCoverFile, writePhotoFile, writeProfilePictureFile } from '@/core/photo/photo-cache';
import { notifyPhotoFetched } from '@/core/photo/photo-events';
import { BlobPaths, getBlob } from '@/core/services/blob-relay';
import { timed, timedSync } from '@/core/utils/timing';

/** First retry waits this long; each further failure doubles it, up to `MAX_BACKOFF_MS`. */
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * How many pending profile pictures to fetch in one parallel batch.
 */
const PICTURE_BATCH_LIMIT = 20;

export type DrainBudget = {
  /** Stop after this many photos. */
  maxPhotos?: number;
  /** Stop once this many milliseconds have elapsed — for a background task's short window. */
  deadlineMs?: number;
};

/** Only one drain runs at a time; a nudge arriving mid-drain is a no-op rather than a second worker. */
let inFlight: Promise<void> | null = null;

function backoffFor(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/**
 * Downloads one attachment's bytes and stores them, or records the
 * failure and when to try again. Never throws: a failure here is data
 * about that one photo, not a reason to stop the queue.
 */
async function fetchOne(attachment: FetchableAttachment): Promise<void> {
  const { circleId, entryId, hash, keyVersion, fetchAttempts } = attachment;
  try {
    const keyMap = await getCircleKeyMap(circleId);
    const key = keyVersion === null ? undefined : keyMap?.[keyVersion];
    if (!key) throw new Error(`no content key for version ${keyVersion}`);

    const encrypted = await timed(`photo.fetch(${entryId.slice(0, 8)})`, () => getBlob(circleId, entryId));
    // A blob that isn't there yet is an ordinary race, not corruption:
    // the uploader appends its entry after uploading, but a reader can
    // still arrive between a failed upload and its retry.
    if (!encrypted) throw new Error('blob not found');

    const bytes = timedSync(`photo.decrypt(${encrypted.length} bytes)`, () => decrypt(encrypted, key));
    // The hash rode inside the ciphertext, which is what ties these
    // bytes to the author: the blob is uploaded separately and nothing
    // else connects the two.
    if (hash && hashBytes(bytes) !== hash) throw new Error('photo hash does not match the entry');

    await markAttachmentFetched(circleId, entryId, bytes);
    // Written now, off the render path, so a feed load is only ever a
    // path string — see services/photo-cache.ts.
    if (attachment.kind === AttachmentKinds.CIRCLE_COVER) {
      // Keyed by the cover's own id, which is the last path segment and
      // is already content-addressed — a new cover is a new key.
      const uri = writeCoverFile(circleId, bytes, entryId.split('/').pop() ?? entryId);
      notifyPhotoFetched({ kind: 'cover', circleId, uri });
    } else {
      // Whatever screen is showing this post's placeholder patches just
      // this row rather than reloading — a backlog of many photos landing
      // one by one must not mean a feed reload apiece.
      const uri = writePhotoFile(circleId, entryId, bytes);
      notifyPhotoFetched({ kind: 'post', circleId, postId: entryId, uri });
    }
  } catch (err) {
    const attempts = fetchAttempts + 1;
    console.error(`Failed to fetch attachment ${entryId} (attempt ${attempts})`, err);
    await markAttachmentFailed(circleId, entryId, attempts, Date.now() + backoffFor(attempts));
  }
}

/**
 * A profile picture is never encrypted and is not addressed by circle +
 * entryId the way a post or cover is — it rides on the account, reached
 * through whichever circle this device happens to share with that
 * account. No decrypt, no hash: the relay already serves plain bytes.
 */
async function fetchProfilePicture(picture: ProfilePicture): Promise<void> {
  const { accountId, pictureId, fetchAttempts } = picture;
  try {
    const circleId = await findCircleSharedWith(accountId);
    if (!circleId) throw new Error(`no shared circle with ${accountId}`);

    const bytes = await timed(`photo.fetch(picture:${accountId.slice(0, 8)})`, () =>
      getBlob(circleId, BlobPaths.picture(accountId, pictureId))
    );
    if (!bytes) throw new Error('blob not found');

    await markProfilePictureFetched(accountId, pictureId, bytes);
    const uri = writeProfilePictureFile(accountId, bytes, pictureId);
    notifyPhotoFetched({ kind: 'profilePicture', accountId, uri });
  } catch (err) {
    const attempts = fetchAttempts + 1;
    console.error(`Failed to fetch profile picture for ${accountId} (attempt ${attempts})`, err);
    await markProfilePictureFailed(accountId, pictureId, attempts, Date.now() + backoffFor(attempts));
  }
}

/**
 * Exhausts every pending profile picture before `drain` below ever looks
 * at an attachment. Unlike a post or cover, these are small, undecrypted,
 * and independent of one another, so they go out in parallel batches
 * rather than one at a time through `maxPhotos` — the common "just
 * joined a circle full of strangers" case gets every face at once
 * instead of one round trip per member.
 *
 * Still checks the deadline per batch: if `deadlineMs` ever backs a real
 * background task's window, a backlog spread across several stale
 * circles shouldn't be able to run past it just because it isn't
 * counted against `maxPhotos`.
 */
async function drainProfilePictures(startedAt: number, deadlineMs: number | undefined): Promise<void> {
  for (;;) {
    if (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) return;
    if (!(await getAuthToken())) return;

    const pictures = await getFetchableProfilePictures(Date.now(), PICTURE_BATCH_LIMIT);
    if (pictures.length === 0) return;

    await Promise.all(pictures.map((picture) => fetchProfilePicture(picture)));
  }
}

async function drain(budget: DrainBudget): Promise<void> {
  const startedAt = Date.now();
  await drainProfilePictures(startedAt, budget.deadlineMs);

  const maxPhotos = budget.maxPhotos ?? Infinity;

  for (let fetched = 0; fetched < maxPhotos; fetched += 1) {
    if (budget.deadlineMs !== undefined && Date.now() - startedAt >= budget.deadlineMs) return;
    // Checked per photo so signing out stops a drain already running.
    // Carrying on would fail every fetch and back each photo off for up to a day.
    if (!(await getAuthToken())) return;

    const [next] = await getFetchableAttachments(Date.now(), 1);
    if (!next) return;

    await fetchOne(next);
  }
}

/**
 * Asks the photo queue to make progress, and returns immediately —
 * downloads are bulk work that must never sit in front of a log sync or
 * a screen waiting to render.
 *
 * Safe to call from anywhere, as often as you like: if a drain is already
 * running this does nothing, so overlapping triggers (app foreground, a
 * finished sync pass, a periodic tick) collapse into one worker.
 */
export function nudgePhotoQueue(budget: DrainBudget = {}): void {
  if (inFlight) return;

  inFlight = drain(budget)
    .catch((err) => console.error('Photo queue drain failed', err))
    .finally(() => {
      inFlight = null;
    });
}

/** Awaitable drain, for a background task that must not return before its work is done — and for tests. */
export async function drainPhotoQueue(budget: DrainBudget = {}): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = drain(budget).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The one thing a person can do about a photo marked unavailable: skip
 * the backoff this attachment is currently sitting out and let the queue
 * try it right now, rather than wait — up to a day, once it has failed
 * enough times — for the schedule to come back around on its own.
 *
 * Awaits only the backoff clearing and the nudge, not the fetch itself —
 * a caller that wants to know the outcome watches for onPhotoFetched, the
 * same signal an ordinary background fetch reports through.
 */
export async function retryAttachment(circleId: string, entryId: string): Promise<void> {
  try {
    await clearAttachmentBackoff(circleId, entryId);
    nudgePhotoQueue();
  } catch (err) {
    console.error(`Failed to queue a retry for ${entryId}`, err);
  }
}
