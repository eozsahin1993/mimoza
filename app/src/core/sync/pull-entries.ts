import { getCircle, saveCursors } from '@/data/db';
import { isPermanentWriteFailure } from '@/core/sync/write-failure';
import { entryHandlers, type EntryContext } from '@/core/sync/entry-handlers';
import { walkEntries, type Entry } from '@/features/post/services/post-relay';

/**
 * Walks a circle's entry streams through the relay's opaque cursors.
 *
 * Two kinds of failure, deliberately different. A *transient* one — the
 * fetch throwing, a local write failing — stops the pass where it
 * stands, leaving the cursor where it was so the next trigger resumes.
 * An entry that can never be applied — no key for its version, a type
 * this build doesn't know — is logged and walked past, because stopping
 * on it would wedge the circle forever.
 *
 * Every page is applied before its cursor is saved, so a crash in
 * between replays entries rather than skipping them. Every handler is
 * idempotent for that reason.
 */
async function applyEntries(ctx: EntryContext, entries: Entry[]): Promise<void> {
  for (const entry of entries) {
    const handler = entryHandlers[entry.type];
    if (!handler) {
      console.warn(`Skipping entry ${entry.entryId} in ${ctx.circleId}: unknown type ${entry.type}`);
      continue;
    }
    try {
      await handler(ctx, entry);
    } catch (err) {
      // A constraint violation can never succeed on retry: the entry
      // depends on something this device skipped. Anything else is
      // assumed transient and ends the pass with the cursor still
      // behind — cursors never rewind, so skipping one would lose it.
      if (!isPermanentWriteFailure(err)) throw err;
      console.warn(`Skipping entry ${entry.entryId} in ${ctx.circleId}: could not be applied`, err);
    }
  }
}

/**
 * Everything that changed since this device last looked, applied oldest
 * first. For posts that is one walk covering new posts, new counts,
 * visibility changes and deletions alike, because all of them move
 * `updatedAt`.
 *
 * A circle with no cursor yet reads the newest page instead, which comes
 * back walking *backward*: its `more` is about history, not about
 * catching up, so that read takes one page and seeds both cursors. The
 * rest of the history is `pullOlderPosts`' job, paged as someone
 * scrolls.
 */
export async function pullNewEntries(ctx: EntryContext, type: 'post' | 'activity'): Promise<void> {
  const circle = await getCircle(ctx.circleId);
  if (!circle) return;

  let cursor = type === 'post' ? circle.postsForwardCursor : circle.activityCursor;
  const seeding = !cursor;

  for (;;) {
    const page = await walkEntries(ctx.circleId, type, cursor ?? undefined);
    await applyEntries(ctx, page.entries);

    // An empty page carries no cursors. Saving those would rewind this
    // stream to "newest page" on the next pass.
    if (page.entries.length > 0) {
      await saveCursors(ctx.circleId, {
        ...(type === 'post'
          ? { postsForward: page.next ?? null, ...(seeding ? { postsBackward: page.prev ?? null } : {}) }
          : { activity: page.next ?? null }),
      });
    }

    if (seeding || !page.more || !page.next) return;
    cursor = page.next;
  }
}

/**
 * One page further back. Returns whether any older posts remain, which
 * is what an infinite scroll asks before offering to load more.
 */
export async function pullOlderPosts(ctx: EntryContext): Promise<boolean> {
  const circle = await getCircle(ctx.circleId);
  if (!circle?.postsBackwardCursor) return false;

  const page = await walkEntries(ctx.circleId, 'post', circle.postsBackwardCursor);
  await applyEntries(ctx, page.entries);
  if (page.entries.length > 0) await saveCursors(ctx.circleId, { postsBackward: page.prev ?? null });
  return page.more && page.entries.length > 0;
}
