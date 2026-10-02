import { router } from 'expo-router';
import { useMemo } from 'react';

import type { FeedRow, FeedRows } from '@/features/feed/components/rows';
import { type CommentItem } from '@/features/post/components/post-comments';
import { missingPhotoFor } from '@/ui/components/photo-placeholder';
import { PostCard, type Post, type Reaction } from '@/features/post/components/post-card';
import { Spacing } from '@/ui/theme/tokens';
import { showError } from '@/core/services/messages';
import type { CommentWithAuthor, LocalAccount } from '@/data/db';
import { getComments } from '@/data/db';
import type { FeedPostView } from '@/features/feed/usecases/circle-feed';
import { commentOnPost } from '@/features/post/usecases/comment-on-post';
import { getReactions, toggleReaction } from '@/features/post/usecases/react-to-post';
import { setAlbumVisibility } from '@/features/post/usecases/set-album-visibility';
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
  /** This device's own profile — the name fallback for a post whose author has no roster row yet. */
  profile: LocalAccount | null;
  /** This device's own current picture, for the composer avatar beside the comment box. */
  selfPhotoUri?: string;
  /** The reader's own account id, and whether they may re-file any photo — see set-album-visibility.ts. */
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
  selfPhotoUri,
  ownPublicKey,
  ownIsAdmin,
  language,
}: PostRowsInput): FeedRows {
  const actions = useMemo<PostRowActions>(
    () => ({
      onToggleReaction: async (postId, emoji) => {
        try {
          await toggleReaction(circleId, postId, emoji);
          patchPost(postId, { reactions: await getReactions(postId) });
        } catch (err) {
          console.error('Failed to toggle reaction', err);
          showError(i18n.t('post.reactionFailed'));
        }
      },
      onAddComment: async (postId, body) => {
        const commentId = await commentOnPost(circleId, postId, body);
        const [comment] = await getComments([commentId]);
        const current = posts.find((view) => view.post.id === postId);
        patchPost(postId, { comments: { latest: comment ?? null, total: (current?.comments.total ?? 0) + 1 } });
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
      onSeen: () => {},
      /**
       * Expanding a post's comments is genuinely seeing them — same as
       * opening post/[id].
       */
      onExpandComments: () => {},
    }),
    [circleId, patchPost, posts],
  );

  return useMemo(
    () => ({
      rows: posts.map((view) =>
        postRow(view, profile, selfPhotoUri, actions, ownIsAdmin || view.post.authorId === ownPublicKey, language),
      ),
    }),
    [posts, profile, selfPhotoUri, actions, ownPublicKey, ownIsAdmin, language],
  );
}

function postRow(
  view: FeedPostView,
  profile: LocalAccount | null,
  selfPhotoUri: string | undefined,
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
        selfPhotoUri={selfPhotoUri}
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

/** The relay's counts, adjusted by what's queued, into the shape PostCard already renders. */
function toReactions(summary: FeedPostView['reactions']): Reaction[] {
  return Object.entries(summary.counts).map(([emoji, count]) => ({ emoji, count, reactedByMe: summary.iReacted }));
}

/**
 * Data to view model. Timestamps become strings; nothing else changes
 * shape. Falls back to this device's own name for a post whose author
 * has no roster row yet — the picture has no equivalent fallback, since
 * it resolves through profilePictures the same way for every author,
 * self included.
 */
function toPostCard(view: FeedPostView, profile: LocalAccount | null, language: LanguageCode): Post {
  const { post } = view;
  const isOwn = profile?.accountId === post.authorId;

  return {
    id: post.id,
    authorName: view.authorName || (isOwn ? profile.name : '') || i18n.getFixedT(language)('post.unknownMember'),
    authorPhotoUri: view.authorPhotoUri,
    authorPublicKey: post.authorId,
    timestamp: formatTimestamp(post.createdAt, language),
    photoUri: view.photoUri,
    missingPhoto: view.photoUri ? undefined : missingPhotoFor(view.photoStatus),
    caption: post.caption,
    reactions: toReactions(view.reactions),
    reactionsTotal: view.reactions.total,
    latestComment: view.comments.latest ? toCommentItem(view.comments.latest, language) : undefined,
    commentCount: view.comments.total,
    inAlbum: post.inAlbum,
  };
}

function toCommentItem(comment: CommentWithAuthor & { authorPhotoUri?: string }, language: LanguageCode): CommentItem {
  return {
    id: comment.id,
    authorName: comment.authorName || i18n.getFixedT(language)('post.unknownMember'),
    authorPhotoUri: comment.authorPhotoUri,
    authorPublicKey: comment.authorId,
    body: comment.body,
    timestamp: formatRelative(comment.createdAt, language),
  };
}
