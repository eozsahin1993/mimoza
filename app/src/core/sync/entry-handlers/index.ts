import { EntryTypes } from '@/core/sync/log-entry';
import { accountDeletedHandler } from '@/core/sync/entry-handlers/account-deleted';
import { albumVisibilityHandler } from '@/core/sync/entry-handlers/album-visibility';
import { commentHandler } from '@/core/sync/entry-handlers/comment';
import { circleDeletedHandler } from '@/core/sync/entry-handlers/circle-deleted';
import { circleRenamedHandler } from '@/core/sync/entry-handlers/circle-renamed';
import { pushEnabledHandler } from '@/core/sync/entry-handlers/push-enabled';
import { coverPhotoSetHandler } from '@/core/sync/entry-handlers/cover-photo-set';
import { keyRotationHandler } from '@/core/sync/entry-handlers/key-rotation';
import { memberAddedHandler } from '@/core/sync/entry-handlers/member-added';
import { memberRemovedHandler } from '@/core/sync/entry-handlers/member-removed';
import { postHandler } from '@/core/sync/entry-handlers/post';
import { postDeleteHandler } from '@/core/sync/entry-handlers/post-delete';
import { profileUpdateHandler } from '@/core/sync/entry-handlers/profile-update';
import { reactionHandler } from '@/core/sync/entry-handlers/reaction';
import { roleChangeHandler } from '@/core/sync/entry-handlers/role-change';
import type { EntryHandler } from '@/core/sync/entry-handlers/types';

export type { EntryHandler } from '@/core/sync/entry-handlers/types';

/**
 * Meta entry types this build understands. An entry naming anything else
 * is discarded, which is the correct behaviour rather than a gap: unknown
 * types must default-deny rather than be guessed at, and it's recoverable
 * because local state is a disposable projection, so a later build that
 * understands the type rebuilds it by replaying from epoch 0.
 *
 * The registry test enforces that everything which is written has an
 * entry here.
 */
export const metaHandlers: Record<string, EntryHandler> = {
  [EntryTypes.MEMBER_ADDED]: memberAddedHandler,
  [EntryTypes.PROFILE_UPDATE]: profileUpdateHandler,
  [EntryTypes.MEMBER_REMOVED]: memberRemovedHandler,
  [EntryTypes.ROLE_CHANGE]: roleChangeHandler,
  [EntryTypes.KEY_ROTATION]: keyRotationHandler,
  [EntryTypes.COVER_PHOTO_SET]: coverPhotoSetHandler,
  [EntryTypes.CIRCLE_RENAMED]: circleRenamedHandler,
  [EntryTypes.PUSH_ENABLED]: pushEnabledHandler,
  [EntryTypes.CIRCLE_DELETED]: circleDeletedHandler,
  [EntryTypes.ACCOUNT_DELETED]: accountDeletedHandler,
};

/** Content entry types this build understands. */
export const contentHandlers: Record<string, EntryHandler> = {
  [EntryTypes.POST]: postHandler,
  [EntryTypes.COMMENT]: commentHandler,
  [EntryTypes.REACTION]: reactionHandler,
  [EntryTypes.ALBUM_VISIBILITY]: albumVisibilityHandler,
  [EntryTypes.POST_DELETE]: postDeleteHandler,
};
