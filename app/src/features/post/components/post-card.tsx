import { Image } from 'expo-image';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/ui/components/avatar/avatar';
import { Icon } from '@/ui/components/icon';
import { type CommentItem, PostComments } from '@/features/post/components/post-comments';
import { PhotoPlaceholder, type MissingPhoto } from '@/ui/components/photo-placeholder';
import { ReactionChip } from '@/features/post/components/reaction-chip';
import { EmojiPicker } from '@/ui/components/emoji-picker';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, PhotoAspect, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme } from '@/ui/theme/hooks/use-theme';

export type Reaction = {
  emoji: string;
  count: number;
  reactedByMe?: boolean;
};

export type Post = {
  id: string;
  authorName: string;
  /** Data URI of the author's profile picture, when it's known — otherwise their initials show. */
  authorPhotoUri?: string;
  /** Stabler than `authorName` for the avatar's colour — see `Avatar`'s `colorSeed` prop. */
  authorPublicKey?: string;
  timestamp: string;
  /** Data URI of the actual photo, when it's known — otherwise the hatch placeholder shows. */
  photoUri?: string;
  /** Why there's no photo yet, when there isn't one — see `PhotoPlaceholder`. */
  missingPhoto?: MissingPhoto;
  caption: string;
  reactions: Reaction[];
  /**
   * The count behind the pill — not reactions.reduce, because a reaction
   * under a key version this device can't name yet (see summarise in
   * data/db/reactions.ts) has no emoji to appear in `reactions` at all,
   * but still counts.
   */
  reactionsTotal: number;
  /** The single comment a card shows — the newest. Absent on a post nobody has replied to. */
  latestComment?: CommentItem;
  /** How many there are in all, for the "Show all N" link. */
  commentCount: number;
  /** A comment landed on this post since it was last scrolled into view or opened — shown as a small dot on the comments chip. */
  hasUnseenComments?: boolean;
  /** Whether this photo is kept in the circle's album — lights the bookmark. */
  inAlbum?: boolean;
};

export type PostCardProps = {
  post: Post;
  onToggleReaction?: (emoji: string) => void;
  onAddComment?: (body: string) => void;
  onPressPhoto?: () => void;
  /** Opens the post's own screen, where the whole thread is. */
  onPressComments?: () => void;
  /** Fires the moment comments are expanded — this is genuinely seeing them, same as opening the post itself. */
  onExpandComments?: () => void;
  /** The reader's own picture, for the composer — the same on every card, so it rides on the card rather than each post. */
  selfPhotoUri?: string;
  /** Pairs with `selfPhotoUri` — the composer avatar's initials before a picture is set. */
  selfName?: string;
  /** Adds or removes the photo from the circle's album. */
  onToggleAlbum?: () => void;
};

/** How many distinct emoji the feed's single pill shows before the count speaks for the rest. */
const TOP_EMOJI = 3;

/**
 * The gap between the card's horizontal bands — caption, chips, comments.
 * One value rather than a number per style: they read as a stack, and a
 * stack with three different gaps in it looks like a mistake even when
 * nobody can say which gap is wrong.
 */
const BAND_GAP = 16;

export function PostCard({
  post,
  onToggleReaction,
  onAddComment,
  onPressPhoto,
  onPressComments,
  onExpandComments,
  selfPhotoUri,
  selfName,
  onToggleAlbum,
}: PostCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [showPicker, setShowPicker] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  const totalReactions = post.reactionsTotal;
  const reactedByMe = post.reactions.some((reaction) => reaction.reactedByMe);
  // Most-used first, so the pill says what the reaction was and not just
  // how much of it there was.
  const topEmoji = [...post.reactions]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_EMOJI)
    .map((reaction) => reaction.emoji)
    .join('');

  function handleSelect(emoji: string) {
    onToggleReaction?.(emoji);
    setShowPicker(false);
  }

  function handleShowAll() {
    onExpandComments?.();
    onPressComments?.();
  }

  function handleToggleComposer() {
    setComposerOpen((open) => {
      if (!open) onExpandComments?.();
      return !open;
    });
  }

  return (
    <ThemedView style={styles.card}>
      <View style={styles.header}>
        <Avatar uri={post.authorPhotoUri} name={post.authorName} colorSeed={post.authorPublicKey} />
        <View style={styles.byline}>
          <ThemedText type="titleSmall">{post.authorName}</ThemedText>
          {/* Everyone can see that a photo is kept; only its author or an
              admin gets the chip below that changes it. */}
          <View style={styles.timestampRow}>
            <ThemedText type="labelSmall" themeColor="muted">
              {post.timestamp}
            </ThemedText>
            {post.inAlbum ? (
              <>
                <ThemedText type="labelSmall" themeColor="muted">
                  ·
                </ThemedText>
                <Icon icon={Icons.inAlbum} size={12} color={theme.accent} filled />
                <ThemedText type="labelSmall" themeColor="accent">
                  {t('post.album')}
                </ThemedText>
              </>
            ) : null}
          </View>
        </View>
      </View>

      <Pressable style={styles.photoWrap} onPress={onPressPhoto} disabled={!onPressPhoto}>
        {post.photoUri ? (
          <Image source={{ uri: post.photoUri }} style={styles.photo} contentFit="cover" />
        ) : (
          <PhotoPlaceholder style={styles.photo} missing={post.missingPhoto} />
        )}
      </Pressable>

      {/* Two lines in the feed; the post's own screen carries the rest.
          Tappable as well as the photo, since the ellipsis is what
          promises there's more to read. Dropped entirely when there's no
          caption, so the chips close the gap instead of an empty line
          holding it open. */}
      {post.caption ? (
        <Pressable onPress={onPressPhoto} disabled={!onPressPhoto}>
          <ThemedText type="bodyMedium" style={styles.caption} numberOfLines={2}>
            {post.caption}
          </ThemedText>
        </Pressable>
      ) : null}

      {/* Three named actions, one tone. Each is tinted by the reader's own
          state — the reactions they left, the composer they opened, the
          album they filed this in — never by what the post as a whole has.

          The first swaps its name for the reactions themselves once there
          are any: one pill for all of them, showing the three most-used
          and the total, with the post's own screen carrying the breakdown. */}
      <View style={styles.reactionsRow}>
        {totalReactions > 0 ? (
          <ReactionChip
            emoji={topEmoji}
            label={String(totalReactions)}
            reacted={reactedByMe}
            accessibilityLabel={t('post.reactionCount', { count: totalReactions })}
            onPress={() => setShowPicker((v) => !v)}
          />
        ) : (
          <ReactionChip icon={Icons.react} label={t('post.react')} onPress={() => setShowPicker((v) => !v)} />
        )}

        <View style={styles.commentsChipWrap}>
          <ReactionChip icon={Icons.comment} label={t('post.comment')} reacted={composerOpen} onPress={handleToggleComposer} />
          {post.hasUnseenComments ? (
            <View style={[styles.unseenDot, { backgroundColor: theme.accentBright }]} />
          ) : null}
        </View>

        {onToggleAlbum ? (
          <ReactionChip
            icon={Icons.inAlbum}
            label={t('post.album')}
            reacted={post.inAlbum}
            accessibilityLabel={post.inAlbum ? t('post.removeFromAlbum') : t('post.addToAlbum')}
            onPress={onToggleAlbum}
          />
        ) : null}
      </View>

      {showPicker ? (
        <View style={styles.picker}>
          <EmojiPicker onSelect={handleSelect} onClose={() => setShowPicker(false)} />
        </View>
      ) : null}

      <View style={styles.comments}>
        <PostComments
          latest={post.latestComment}
          total={post.commentCount}
          onSubmit={(body) => onAddComment?.(body)}
          composerOpen={composerOpen}
          onPressShowAll={handleShowAll}
          selfPhotoUri={selfPhotoUri}
          selfName={selfName}
        />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Space.s0,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
    paddingHorizontal: Spacing.feedTextPadding,
    paddingVertical: Space.s400,
  },
  byline: {
    flex: 1,
  },
  timestampRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s100,
  },
  photoWrap: {
    justifyContent: 'flex-end',
  },
  photo: {
    aspectRatio: PhotoAspect.post,
  },
  caption: {
    paddingHorizontal: Spacing.feedTextPadding,
    paddingTop: BAND_GAP,
  },
  commentsChipWrap: {
    position: 'relative',
  },
  unseenDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 9,
    height: 9,
    borderRadius: Radius.pill,
  },
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Space.s200,
    paddingHorizontal: Spacing.feedTextPadding,
    paddingTop: BAND_GAP,
  },
  picker: {
    paddingHorizontal: Spacing.feedTextPadding,
    // Was missing its top gap entirely, so the panel opened flush against
    // the chips that opened it.
    paddingTop: BAND_GAP,
  },
  comments: {
    paddingHorizontal: Spacing.feedTextPadding,
    paddingTop: BAND_GAP,
    // The feed's own gap follows this card; only enough here to keep the
    // last line off the join.
    paddingBottom: Space.s100,
  },
});
