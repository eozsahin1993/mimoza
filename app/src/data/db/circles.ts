import { and, asc, count, eq, gt, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import {
  attachments,
  circleInvites,
  circleMembers,
  circles,
  memberEvents,
  outbox,
  postComments,
  postReactions,
  posts,
} from '@/data/db/schema';

export type Circle = typeof circles.$inferSelect;

function normalizeCircle(circle: Circle): Circle {
  return { ...circle, picture: normalizeBlob(circle.picture) };
}

export async function insertCircle(circle: typeof circles.$inferInsert): Promise<void> {
  await db.insert(circles).values(circle);
}

export async function getCircle(id: string): Promise<Circle | null> {
  const rows = await db.select().from(circles).where(eq(circles.id, id));
  return rows[0] ? normalizeCircle(rows[0]) : null;
}

/**
 * Finds a circle by its relay-facing address rather than its local id.
 *
 * Only recovery needs this: it learns circles from the account manifest and
 * must not insert a second local row for one this device already has.
 * `syncId` has no unique index and `insertCircle` is a plain insert, so
 * nothing else would catch the duplicate — it would just quietly replay the
 * same circle into a parallel set of rows.
 */
export async function getCircleBySyncId(syncId: string): Promise<Circle | null> {
  const rows = await db.select().from(circles).where(eq(circles.syncId, syncId));
  return rows[0] ? normalizeCircle(rows[0]) : null;
}

/** Each joined circle's local id and log address — what the account manifest records. */
export async function listCircleAddresses(): Promise<{ id: string; syncId: string }[]> {
  return db
    .select({ id: circles.id, syncId: circles.syncId })
    .from(circles)
    .where(isNull(circles.leftAt));
}

/** Circles this device has left but still has a row for — what the account manifest tombstones. */
export async function listLeftCircles(): Promise<{ id: string; syncId: string; leftAt: number }[]> {
  const rows = await db
    .select({ id: circles.id, syncId: circles.syncId, leftAt: circles.leftAt })
    .from(circles)
    .where(isNotNull(circles.leftAt));
  return rows.map((row) => ({ id: row.id, syncId: row.syncId, leftAt: row.leftAt ?? Date.now() }));
}

/**
 * The circle list's rows, without the cover blob.
 *
 * `getAllCircles` is `select()` — every column, so a 200KB cover crosses
 * into JS on every read. That crossing is far more expensive than its size
 * suggests: the driver hands drizzle `{data: number[]}`, so `normalizeBlob`
 * materialises one boxed JS number per byte (~1.6MB of array for a 200KB
 * cover) before copying it into a Uint8Array. The circle list re-reads on
 * every focus, so navigating in and out of a feed repeated that until the
 * heap was thrashing and the JS thread stalled for 30-40s a hop.
 *
 * A screen that needs the cover's *pixels* should read it once through the
 * photo cache, not pull the bytes through this query.
 */
export type CircleListRow = Pick<Circle, 'id' | 'name' | 'createdAt' | 'lastViewedAt'>;

export async function listCircles(): Promise<CircleListRow[]> {
  return db
    .select({ id: circles.id, name: circles.name, createdAt: circles.createdAt, lastViewedAt: circles.lastViewedAt })
    .from(circles)
    .where(isNull(circles.leftAt))
    .orderBy(asc(circles.createdAt));
}

/**
 * One circle without its cover blob — for the screens that only show its
 * name. `getCircle` is select(), so reaching for it just to read `.name`
 * pulls a ~200KB picture through the driver as one boxed JS number per
 * byte. Use this unless you actually need the bytes.
 */
export async function getCircleSummary(id: string): Promise<CircleListRow | null> {
  const rows = await db
    .select({ id: circles.id, name: circles.name, createdAt: circles.createdAt, lastViewedAt: circles.lastViewedAt })
    .from(circles)
    .where(eq(circles.id, id));
  return rows[0] ?? null;
}

/**
 * Just one circle's cover bytes. Its only caller writes them straight into
 * the photo cache, so this runs once per circle rather than per focus —
 * see listCircles above for why pulling the blob repeatedly is so costly.
 */
export async function getCircleCoverBytes(id: string): Promise<Uint8Array | null> {
  const rows = await db.select({ picture: circles.picture }).from(circles).where(eq(circles.id, id));
  return rows[0] ? normalizeBlob(rows[0].picture) : null;
}

/**
 * Just the cover's hash — cheap enough to check on every focus, unlike
 * the blob itself. See circle-cover.ts's resolveCircleCoverUri, which
 * uses this to tell "still the same cover" from "just changed" without
 * paying for the bytes.
 */
export async function getCircleCoverHash(id: string): Promise<string | null> {
  const rows = await db.select({ pictureHash: circles.pictureHash }).from(circles).where(eq(circles.id, id));
  return rows[0]?.pictureHash ?? null;
}

/** Circles this device is still an active member of — excludes ones it's left. */
export async function getAllCircles(): Promise<Circle[]> {
  const rows = await db.select().from(circles).where(isNull(circles.leftAt)).orderBy(asc(circles.createdAt));
  return rows.map(normalizeCircle);
}

/**
 * The circles this device has left but still keeps as a local archive —
 * exactly what `getAllCircles` filters out.
 *
 * Needed because leaving is announced on the log: the departure entry is
 * queued at the moment you leave and pushed whenever there's a
 * connection, so something has to keep visiting a circle that is no
 * longer "yours" until that entry has gone out. See
 * `finishDeparture` in leave-circle.ts.
 */
export async function getLeftCircles(): Promise<Circle[]> {
  const rows = await db.select().from(circles).where(isNotNull(circles.leftAt)).orderBy(asc(circles.createdAt));
  return rows.map(normalizeCircle);
}

/**
 * Records how far this device has replayed one namespace of a circle's
 * log. Always set to the epoch of the last entry actually *processed*,
 * never blindly to the relay's reported latest — a short page would
 * otherwise skip everything it didn't return.
 */
export async function advanceCircleCursor(id: string, namespace: 'meta' | 'content', epoch: number): Promise<void> {
  const column = namespace === 'meta' ? { metaCursor: epoch } : { contentCursor: epoch };
  await db.update(circles).set(column).where(eq(circles.id, id));
}

/** Marks this circle as opened just now — the circle-list badge's "new post" floor. */
export async function markCircleViewed(id: string): Promise<void> {
  await db.update(circles).set({ lastViewedAt: Date.now() }).where(eq(circles.id, id));
}

/**
 * The circle-list badge's count: new posts plus new comments, excluding
 * `ownPublicKey` (no badge for your own actions) and never touching
 * `post_reactions` — reactions are too low-effort a signal, and there's no
 * "who reacted" UI to attribute one with (see the design discussion this
 * came out of).
 *
 * `circleCreatedAt`/`circleLastViewedAt` come from the caller's own
 * `CircleListRow` rather than being looked up again here — `listCircles()`
 * already has them, and this runs once per circle in the list.
 *
 * A comment floors against `circleCreatedAt`, not just the post's own
 * `lastViewedAt`: a post that's never been individually scrolled past or
 * opened has a permanently-null `lastViewedAt`, and without this floor its
 * entire pre-join comment history would count as unread forever for a
 * freshly-joined circle.
 */
export async function getUnreadCount(
  circleId: string,
  ownPublicKey: string,
  circleCreatedAt: number,
  circleLastViewedAt: number
): Promise<number> {
  const newPosts = await db
    .select({ count: count() })
    .from(posts)
    .where(and(eq(posts.circleId, circleId), ne(posts.authorPublicKey, ownPublicKey), gt(posts.createdAt, circleLastViewedAt)));

  const newComments = await db
    .select({ count: count() })
    .from(postComments)
    .innerJoin(posts, eq(posts.id, postComments.postId))
    .where(
      and(
        eq(posts.circleId, circleId),
        ne(postComments.authorPublicKey, ownPublicKey),
        gt(postComments.createdAt, circleCreatedAt),
        or(isNull(posts.lastViewedAt), gt(postComments.createdAt, posts.lastViewedAt))
      )
    );

  return (newPosts[0]?.count ?? 0) + (newComments[0]?.count ?? 0);
}

export async function updateCircleName(id: string, name: string): Promise<void> {
  await db.update(circles).set({ name }).where(eq(circles.id, id));
}

export async function updateCirclePicture(id: string, picture: Uint8Array | null, hash: string | null): Promise<void> {
  await db.update(circles).set({ picture, pictureHash: hash }).where(eq(circles.id, id));
}

/**
 * Marks this device as having left the circle — a soft leave, not a
 * delete. Already-synced posts stay in SQLite as a local archive; this
 * just removes the circle from the active list and stops it appearing as
 * something you can still post to. Pair with `deleteCircleKeys` so this
 * device also loses the ability to sign new posts or decrypt anything new.
 */
export async function markCircleLeft(id: string): Promise<void> {
  await db.update(circles).set({ leftAt: Date.now() }).where(and(eq(circles.id, id), isNull(circles.leftAt)));
}

/**
 * Removes a circle and everything derived from it on this device.
 *
 * Children go explicitly, child-first, rather than by foreign-key cascade
 * — same choice `deletePostLocally` and `resetAllLocalData` make, for the
 * same reason: `PRAGMA foreign_keys` is a per-connection setting SQLite
 * defaults to *off*, so cascade only fires where something turned it on
 * for that exact connection. A path reaching this before `runMigrations`
 * has, or a future second connection, would silently orphan a circle's
 * entire history instead of failing.
 *
 * Orphaned rows aren't merely untidy here. `posts.id` is unique on its own
 * rather than per circle, so a post left behind by one circle silently
 * swallows the same post replaying into another — which is what rejoining
 * a circle you had left used to do.
 */
export async function deleteCircle(id: string): Promise<void> {
  const circlePosts = db.select({ id: posts.id }).from(posts).where(eq(posts.circleId, id));
  db.transaction((tx) => {
    tx.delete(postComments).where(inArray(postComments.postId, circlePosts)).run();
    tx.delete(postReactions).where(inArray(postReactions.postId, circlePosts)).run();
    tx.delete(posts).where(eq(posts.circleId, id)).run();
    tx.delete(attachments).where(eq(attachments.circleId, id)).run();
    tx.delete(memberEvents).where(eq(memberEvents.circleId, id)).run();
    tx.delete(circleMembers).where(eq(circleMembers.circleId, id)).run();
    tx.delete(circleInvites).where(eq(circleInvites.circleId, id)).run();
    tx.delete(outbox).where(eq(outbox.circleId, id)).run();
    tx.delete(circles).where(eq(circles.id, id)).run();
  });
}

/** Records whether this account has silenced a circle's notifications. */
export async function setCirclePushSilenced(id: string, pushSilenced: boolean): Promise<void> {
  await db.update(circles).set({ pushSilenced }).where(eq(circles.id, id));
}

/** Records which content-key version the relay's push hash was written for. */
export async function setCirclePushKeyVersion(id: string, pushKeyVersion: number): Promise<void> {
  await db.update(circles).set({ pushKeyVersion }).where(eq(circles.id, id));
}

/** Records which notification categories a circle sends. */
export async function setCirclePushCategoryMask(id: string, pushCategoryMask: number): Promise<void> {
  await db.update(circles).set({ pushCategoryMask }).where(eq(circles.id, id));
}
