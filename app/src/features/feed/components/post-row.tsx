import { router } from 'expo-router';
import { useMemo } from 'react';

import type { FeedRow, FeedRows } from '@/features/feed/components/rows';
import { type CommentItem } from '@/features/post/components/post-comments';
import { missingPhotoFor } from '@/ui/components/photo-placeholder';
import { PostCard, type Post } from '@/features/post/components/post-card';
import { Spacing } from '@/ui/theme/tokens';
import { showError } from '@/core/services/messages';
import type { CommentWithAuthor, Profile } from '@/data/db';
import type { FeedPostView } from '@/features/feed/usecases/circle-feed';
import { getCommentSummaries, markPostViewed } from '@/data/db';
import { addComment } from '@/features/post/usecases/comment-on-post';
import { getReactionsForPost, toggleReaction } from '@/features/post/usecases/react-to-post';
import { setAlbumVisibility } from '@/features/post/usecases/set-album-visibility';
import { bytesToDataUri } from '@/core/photo/image';
import { formatRelative, formatTimestamp } from '@/core/utils/time';
import { i18n } from '@/core/i18n/i18n';
import type { LanguageCode } from '@/core/i18n/languages';

/**
 * What this kind can't work out for itself. The feed lives in whoever
 * loaded it, so writing back to a post is injected; everything else —
 * which use case to call, what to do afterwards — is decided here.
 */
export type PostRowsInput = {
  circleId: string;
  /** Applies a change to one post, in place, without re-reading the feed. */
  patchPost: (postId: string, change: Partial<FeedPostView>) => void;
  posts: FeedPostView[];
  /** This device's own profile — the fallback for a post whose author has no roster row yet. */
  profile: Profile | null;
  /** Who the reader is, and whether they may re-file any photo — see set-album-visibility.ts. */
  ownPublicKey: string | null;
  ownIsAdmin: boolean;
  language: LanguageCode;
};

/** Only callbacks. Anything derivable from `feed` is derived below rather than passed in. */
type PostRowActions = {
  onToggleReaction: (postId: string, emoji: string) => void;
  onAddComment: (postId: string, body: string) => void;
  onOpenPost: (postId: string) => void;
  onExpandComments: (postId: string) => void;
  /** Scrolled into view — not the same as opening it. */
  onSeen: (postId: string) => void;
  onToggleAlbum: (view: FeedPostView) => void;
};

/**
 * A post row's behaviour and its rendering, in one place. Every action
 * updates the single post it touched rather than re-reading the feed: a
 * reaction shouldn't cost a full reload, and a reload would also drop the
 * open composer on every other card.
 */
export function usePostRows({
  circleId,
  patchPost,
  posts,
  profile,
  ownPublicKey,
  ownIsAdmin,
  language,
}: PostRowsInput): FeedRows {
  const actions = useMemo<PostRowActions>(
    () => ({
      onToggleReaction: async (postId, emoji) => {
        await toggleReaction(circleId, postId, emoji);
        patchPost(postId, { reactions: await getReactionsForPost(circleId, postId) });
      },
      onAddComment: async (postId, body) => {
        await addComment(circleId, postId, body);
        const summaries = await getCommentSummaries(circleId, [postId]);
        patchPost(postId, { comments: summaries.get(postId) ?? { latest: null, total: 0 } });
      },
      /**
       * Optimistic, like the post's own screen: the write is local-first
       * and the entry is queued, so the only thing left to wait on is a
       * network push that must never hold the bookmark up.
       */
      onToggleAlbum: async (view) => {
        const { id } = view.post;
        const next = !view.post.inAlbum;
        patchPost(id, { post: { ...view.post, inAlbum: next } });
        try {
          await setAlbumVisibility(circleId, id, next);
        } catch (err) {
          console.error('Failed to change album visibility', err);
          patchPost(id, { post: view.post });
          showError(next ? i18n.t('post.addToAlbumFailed') : i18n.t('post.removeFromAlbumFailed'));
        }
      },
      onOpenPost: (postId) => router.push({ pathname: '/post/[id]', params: { id: postId, circleId } }),
      onSeen: (postId) => markPostViewed(postId).catch((err) => console.error('Failed to mark a post viewed', err)),
      /**
       * Expanding a post's comments is genuinely seeing them — same as
       * opening post/[id] — so it clears the "new comments" dot immediately
       * rather than waiting for the next full reload to notice.
       */
      onExpandComments: (postId) => {
        markPostViewed(postId).catch((err) => console.error('Failed to mark a post viewed', err));
        patchPost(postId, { hasUnseenComments: false });
      },
    }),
    [circleId, patchPost],
  );

  return useMemo(
    () => ({
      rows: posts.map((view) =>
        postRow(view, profile, actions, ownIsAdmin || view.post.authorPublicKey === ownPublicKey, language),
      ),
    }),
    [posts, profile, actions, ownPublicKey, ownIsAdmin, language],
  );
}

function postRow(
  view: FeedPostView,
  profile: Profile | null,
  actions: PostRowActions,
  canEditAlbum: boolean,
  language: LanguageCode,
): FeedRow {
  const post = toPostCard(view, profile, language);

  return {
    key: post.id,
    spacing: Spacing.gapBetweenPosts,
    at: view.post.createdAt,
    onSeen: () => actions.onSeen(post.id),
    render: () => (
      <PostCard
        post={post}
        selfPhotoUri={pictureUri(profile?.picture)}
        selfName={profile?.name}
        onToggleReaction={(emoji) => actions.onToggleReaction(post.id, emoji)}
        onAddComment={(body) => actions.onAddComment(post.id, body)}
        onPressPhoto={() => actions.onOpenPost(post.id)}
        onPressComments={() => actions.onOpenPost(post.id)}
        onExpandComments={() => actions.onExpandComments(post.id)}
        onToggleAlbum={canEditAlbum ? () => actions.onToggleAlbum(view) : undefined}
      />
    ),
  };
}

/**
 * Base64 is the one expensive thing in this file, and a row rebuild is
 * cheap otherwise — so cache by the bytes' own identity. Rebuilds happen
 * on every `patchPost` (a reaction, a comment) and those leave every
 * untouched post's picture the same array, so this hits on all but the
 * first pass after a reload.
 */
const dataUris = new WeakMap<Uint8Array, string>();

function pictureUri(picture: Uint8Array | null | undefined): string | undefined {
  if (!picture) return undefined;

  const cached = dataUris.get(picture);
  if (cached) return cached;

  const uri = bytesToDataUri(picture);
  dataUris.set(picture, uri);
  return uri;
}

/**
 * Data to view model. Author name and picture already came resolved from
 * the roster; this only turns bytes into data URIs and timestamps into
 * strings. Falls back to this device's own profile for a post whose author
 * has no roster row yet.
 */
function toPostCard(view: FeedPostView, profile: Profile | null, language: LanguageCode): Post {
  const { post } = view;
  const picture = post.authorPicture ?? profile?.picture;

  return {
    id: post.id,
    authorName: post.authorName || profile?.name || i18n.getFixedT(language)('post.unknownMember'),
    authorPhotoUri: pictureUri(picture),
    timestamp: formatTimestamp(post.createdAt, language),
    photoUri: view.photoUri,
    missingPhoto: view.photoUri ? undefined : missingPhotoFor(post.photoStatus),
    caption: post.caption,
    reactions: view.reactions,
    authorPublicKey: post.authorPublicKey,
    latestComment: view.comments.latest ? toCommentItem(view.comments.latest, language, profile?.name) : undefined,
    commentCount: view.comments.total,
    hasUnseenComments: view.hasUnseenComments,
    inAlbum: post.inAlbum,
  };
}

/**
 * Author names on comments resolve live from the roster, so a member
 * renaming themselves updates every comment they wrote. Falls back to this
 * device's own profile for a comment written before its author's roster
 * row arrived — which is the local author's own comments, pre-sync.
 */
function toCommentItem(comment: CommentWithAuthor, language: LanguageCode, ownName?: string): CommentItem {
  return {
    id: comment.id,
    authorName: comment.authorName || ownName || i18n.getFixedT(language)('post.unknownMember'),
    authorPhotoUri: pictureUri(comment.authorPicture),
    authorPublicKey: comment.authorPublicKey,
    body: comment.body,
    timestamp: formatRelative(comment.createdAt, language),
  };
}
