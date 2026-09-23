import { insertActivity, rememberDepartedMember } from '@/data/db';
import type { EntryContext } from '@/core/sync/entry-handlers/types';
import type { Entry } from '@/features/post/services/post-relay';

/** What the relay records about the circle itself. Plaintext: it wrote them. */
export const ActivityEvents = {
  CREATED: 'created',
  JOINED: 'joined',
  LEFT: 'left',
  REMOVED: 'removed',
  ACCOUNT_DELETED: 'account_deleted',
  PROMOTED: 'promoted',
  DEMOTED: 'demoted',
  RENAMED: 'renamed',
  COVER_CHANGED: 'cover_changed',
} as const;

const DEPARTURES = new Set<string>([
  ActivityEvents.LEFT,
  ActivityEvents.REMOVED,
  ActivityEvents.ACCOUNT_DELETED,
]);

/**
 * Applies one activity entry. The roster itself comes from `/me` and the
 * roster fetch; this is the history the wall shows beside posts.
 *
 * A departure is also written to `circle_members`, because the roster it
 * will next fetch no longer names that person — and a post or reaction
 * of theirs still has to resolve to one. `subjectName` is the name at
 * the time, which is the only copy left once the account is gone.
 */
export async function applyActivityEntry(ctx: EntryContext, entry: Entry): Promise<void> {
  await insertActivity({
    id: entry.entryId,
    circleId: ctx.circleId,
    event: entry.event ?? '',
    actorId: entry.authorId,
    subjectId: entry.subjectId ?? null,
    subjectName: entry.subjectName ?? null,
    receivedAt: entry.receivedAt,
  });

  if (entry.event && DEPARTURES.has(entry.event) && entry.subjectId) {
    await rememberDepartedMember(ctx.circleId, entry.subjectId, entry.subjectName ?? '', entry.receivedAt);
  }
}
