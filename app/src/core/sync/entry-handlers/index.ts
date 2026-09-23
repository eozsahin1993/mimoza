import { applyActivityEntry } from '@/core/sync/entry-handlers/activity';
import { applyPostEntry } from '@/core/sync/entry-handlers/post';
import type { EntryHandler } from '@/core/sync/entry-handlers/types';

export { ActivityEvents } from '@/core/sync/entry-handlers/activity';
export { applyChildrenEntries } from '@/core/sync/entry-handlers/children';
export { entryContext, type EntryContext, type EntryHandler } from '@/core/sync/entry-handlers/types';

/**
 * The two types a walk delivers. Anything else is discarded rather than
 * guessed at — local state is a projection, so a later build that
 * understands the type rebuilds it by walking again.
 *
 * Comments and reactions are not here: they are children of a post,
 * fetched when one is opened, never walked.
 */
export const entryHandlers: Record<string, EntryHandler> = {
  post: applyPostEntry,
  activity: applyActivityEntry,
};
