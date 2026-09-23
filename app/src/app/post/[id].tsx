import type { TFunction } from 'i18next';
import { bytesToHex } from '@noble/curves/utils.js';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { ActionSheet } from '@/ui/components/action-sheet';
import { Avatar } from '@/ui/components/avatar/avatar';
import { Icon } from '@/ui/components/icon';
import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { FabButton } from '@/ui/components/buttons/fab-button';
import { HeaderIconButton } from '@/ui/components/navbar/header-icon-button';
import { missingPhotoFor, PhotoPlaceholder } from '@/ui/components/photo-placeholder';
import { ReactionChip } from '@/features/post/components/reaction-chip';
import { EmojiPicker } from '@/ui/components/emoji-picker';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Fonts, Icons, PhotoAspect, Radius, Space, Spacing } from '@/ui/theme/tokens';
import {
  getAttachment,
  getCircle,
  getMember,
  getPost,
  listComments,
  listReactors,
  getProfile,
  type CommentWithAuthor,
  type Post,
} from '@/data/db';
import { commentOnPost } from '@/features/post/usecases/comment-on-post';
import { deletePost } from '@/features/post/usecases/delete-post';
import { openPost } from '@/features/post/usecases/open-post';
import { getReactions, toggleReaction } from '@/features/post/usecases/react-to-post';
import { setAlbumVisibility } from '@/features/post/usecases/set-album-visibility';
import { useTheme } from '@/ui/theme/hooks/use-theme';
import { showError, showMessage } from '@/core/services/messages';
import { bytesToDataUri } from '@/core/photo/image';
import { getCircleIdentity } from '@/core/services/keystore/circle-keys';
import { ensurePhotoUri, writePhotoFile } from '@/core/photo/photo-cache';
import { onPhotoFetched } from '@/core/photo/photo-events';
import { formatDay, formatRelative, formatTimestamp } from '@/core/utils/time';
import { useLanguage } from '@/core/i18n/use-language';

/** Names shown before the rest become "& N others" — enough to recognise who, not a roster dump. */
const PREVIEW_NAMES = 3;

/** "Aunt Ro, Dad, Emre & 5 others reacted." — or every name, once expanded. */
function describeReactors(names: string[], expanded: boolean, t: TFunction): string {
  const shown = expanded ? names : names.slice(0, PREVIEW_NAMES);
  const hidden = names.length - shown.length;

  return hidden > 0
    ? t('post.details.reactedWithOthers', { names: shown.join(', '), count: hidden })
    : t('post.details.reacted', { names: shown.join(', '), count: shown.length });
}

/** One emoji's chip: the relay's count, and whether one of them is yours. */
type ReactionChipView = { emoji: string; count: number; reactedByMe: boolean };

export default function PostDetailsScreen() {
  const { t } = useTranslation();
  const language = useLanguage();
  const theme = useTheme();
  const { id: postId, circleId } = useLocalSearchParams<{ id: string; circleId: string }>();

  const [circleName, setCircleName] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [photoStatus, setPhotoStatus] = useState<string | undefined>();
  const [post, setPost] = useState<Post | null>(null);
  const [photoUri, setPhotoUri] = useState<string | undefined>();
  const [profileName, setProfileName] = useState<string | undefined>();
  const [reactions, setReactions] = useState<ReactionChipView[]>([]);
  const [reactors, setReactors] = useState<string[]>([]);
  const [comments, setComments] = useState<CommentWithAuthor[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [showAllReactors, setShowAllReactors] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [showActions, setShowActions] = useState(false);
  /** The author or an admin, and nobody else — the rule both `setAlbumVisibility` and `deletePost` enforce. */
  const [canEditPost, setCanEditPost] = useState(false);
  /** Which of the two it is, so the sheet can say why deleting is offered. */
  const [ownPost, setOwnPost] = useState(false);

  const load = useCallback(async () => {
    if (!circleId || !postId) return;

    const [circle, storedPost, profile, summary, everyReactor, postComments] = await Promise.all([
      getCircle(circleId),
      getPost(postId),
      getProfile(),
      getReactions(postId),
      listReactors(postId),
      listComments(postId),
    ]);

    setCircleName(circle?.name ?? '');
    setPost(storedPost);
    setProfileName(profile?.name);
    setComments(postComments);
    setReactors(everyReactor.filter((reactor) => reactor.name).map((reactor) => reactor.name));

    // One chip per emoji, and whether it is one of yours — the post row
    // carries a single iReacted, which cannot say which emoji.
    const mineByEmoji = new Set(
      everyReactor.filter((reactor) => reactor.accountId === profile?.accountId).map((reactor) => reactor.emoji)
    );
    setReactions(
      Object.entries(summary.counts).map(([emoji, count]) => ({ emoji, count, reactedByMe: mineByEmoji.has(emoji) }))
    );

    const mine = profile != null && profile.accountId === storedPost?.authorId;
    setOwnPost(mine);
    setCanEditPost(mine || (await getMember(circleId, profile?.accountId ?? ''))?.role === 'admin');

    // Every member sees the author's name from the roster, which keeps
    // someone who has left attributable.
    const author = storedPost ? await getMember(circleId, storedPost.authorId) : null;
    setAuthorName(author?.name ?? '');

    const attachment = await getAttachment(circleId, postId);
    setPhotoStatus(attachment?.status);
    if (attachment) {
      let uri = ensurePhotoUri(circleId, postId, () => null);
      if (!uri && attachment.bytes) uri = writePhotoFile(circleId, postId, attachment.bytes);
      setPhotoUri(uri ?? undefined);
    } else {
      setPhotoUri(undefined);
    }

    // Marks it seen and refreshes the comments and reactions behind what
    // is already on screen, if the relay has touched the post since they
    // were last fetched.
    openPost(circleId, postId).catch((err) => console.error('Failed to open the post', err));
  }, [circleId, postId]);

  useFocusEffect(
    useCallback(() => {
      load().catch((err) => console.error('Failed to load post details', err));
    }, [load]),
  );

  // The photo landing while its placeholder is on screen sets it directly
  // rather than reloading everything else this screen shows.
  useEffect(
    () =>
      onPhotoFetched((event) => {
        if (event.circleId === circleId && event.postId === postId) setPhotoUri(event.uri);
      }),
    [circleId, postId],
  );

  async function handleSelectReaction(emoji: string) {
    if (!circleId || !postId) return;
    await toggleReaction(circleId, postId, emoji);
    setShowPicker(false);
    // Re-read rather than patch: summarise already folds the queued tap
    // into the relay's counts, so this is the same number the wall shows.
    await load();
  }

  async function handleToggleAlbum() {
    if (!circleId || !postId || !post) return;
    const next = !post.inAlbum;
    // Optimistic: the write is local-first and the entry is queued, so
    // the only thing left to wait on is a network push that must never
    // hold the button up.
    setPost({ ...post, inAlbum: next });
    try {
      await setAlbumVisibility(circleId, postId, next);
    } catch (err) {
      console.error('Failed to change album visibility', err);
      setPost({ ...post, inAlbum: post.inAlbum });
      // The revert is otherwise indistinguishable from the tap not
      // registering, or from the app undoing it on a whim.
      showError(next ? t('post.addToAlbumFailed') : t('post.removeFromAlbumFailed'));
    }
  }

  /**
   * Confirms first, because this is for everyone and there is no undo —
   * the same weight `removeMember` carries on the details screen. Leaves
   * the screen on success: what it was showing no longer exists.
   */
  function handleDelete() {
    if (!circleId || !postId) return;

    Alert.alert(t('post.details.deleteConfirmTitle'), t('post.details.deleteConfirmMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('post.details.delete'), style: 'destructive', onPress: runDelete },
    ]);
  }

  /** The deletion itself, so Retry doesn't ask a question already answered. */
  function runDelete() {
    if (!circleId || !postId) return;

    deletePost(circleId, postId)
      .then(() => {
        router.back();
        showMessage(t('post.details.deleted'), { icon: Icons.deletePost });
      })
      .catch((err) => {
        console.error('Failed to delete the post', err);
        showError(t('post.details.deleteFailed'), { action: { label: t('post.details.retry'), onPress: runDelete } });
      });
  }

  async function handleSubmitComment() {
    if (!circleId || !postId || !commentText.trim()) return;
    const body = commentText;
    setCommentText('');
    await commentOnPost(circleId, postId, body);
    setComments(await listComments(postId));
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <View style={styles.headerInset}>
          <ScreenHeader
            title={t('post.details.title')}
            subtitle={circleName}
            actions={
              // Both are about the post as a whole, so they sit in the
              // header rather than among the chips, which are each about
              // one emoji. Both carry the same rule — the photo's author
              // or an admin — so they appear and disappear together.
              canEditPost && post ? (
                <>
                  <HeaderIconButton
                    icon={Icons.inAlbum}
                    active={post.inAlbum}
                    accessibilityLabel={post.inAlbum ? t('post.removeFromAlbum') : t('post.addToAlbum')}
                    onPress={handleToggleAlbum}
                  />
                  <HeaderIconButton
                    icon={Icons.more}
                    accessibilityLabel={t('post.details.more')}
                    onPress={() => setShowActions(true)}
                  />
                </>
              ) : null
            }
          />
        </View>

        <KeyboardAvoider style={styles.body}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            {photoUri ? (
              <Image source={{ uri: photoUri }} style={styles.photo} contentFit="cover" />
            ) : (
              <PhotoPlaceholder style={styles.photo} missing={missingPhotoFor(photoStatus)} />
            )}

            {post ? (
              <>
                {post.caption ? (
                  <ThemedText type="bodyLarge" style={styles.caption}>
                    {post.caption}
                  </ThemedText>
                ) : null}
                {/* Without a caption the byline takes its place under the
                    photo, rather than sitting tight against it. The album
                    marker shows for everyone; only the author or an admin
                    gets the bookmark in the header that changes it. */}
                <View style={[styles.byline, post.caption ? null : styles.bylineAlone]}>
                  <ThemedText type="labelSmall" themeColor="muted">
                    {authorName || profileName || t('post.unknownMember')} · {formatTimestamp(post.createdAt, language)}
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
              </>
            ) : null}

            {/* One chip per emoji here, unlike the feed's single pill — this
                is the screen that carries the breakdown. The bare "+" only
                works next to them; with nothing to add to, it names itself. */}
            <View style={styles.reactions}>
              {reactions.map((reaction) => (
                <ReactionChip
                  key={reaction.emoji}
                  emoji={reaction.emoji}
                  label={String(reaction.count)}
                  reacted={reaction.reactedByMe}
                  onPress={() => handleSelectReaction(reaction.emoji)}
                />
              ))}
              {reactions.length > 0 ? (
                <ReactionChip label="+" accessibilityLabel={t('post.addReaction')} onPress={() => setShowPicker((v) => !v)} />
              ) : (
                <ReactionChip icon={Icons.react} label={t('post.react')} onPress={() => setShowPicker((v) => !v)} />
              )}
            </View>

            {showPicker ? (
              <View style={styles.picker}>
                <EmojiPicker onSelect={handleSelectReaction} onClose={() => setShowPicker(false)} />
              </View>
            ) : null}

            {/* Who reacted, as people rather than per emoji — the chips
                above already carry which emoji and how many. */}
            {reactors.length > 0 ? (
              <ThemedText type="bodySmall" themeColor="secondary" style={styles.reactors}>
                {describeReactors(reactors, showAllReactors, t)}
                {reactors.length > PREVIEW_NAMES ? (
                  <>
                    {' '}
                    {/* Nested so it flows with the names instead of being
                        pinned somewhere a long list can't wrap to. */}
                    <ThemedText type="bodySmall" themeColor="accentBright" onPress={() => setShowAllReactors((v) => !v)}>
                      {showAllReactors ? t('post.details.seeLess') : t('post.details.seeAll')}
                    </ThemedText>
                  </>
                ) : null}
              </ThemedText>
            ) : null}

            {comments.length > 0 ? <View style={[styles.divider, { backgroundColor: theme.faintest }]} /> : null}

            <View style={styles.comments}>
              {comments.map((comment) => (
                <View key={comment.id} style={styles.commentRow}>
                  <Avatar
                    size={36}
                    name={comment.authorName || profileName}
                    colorSeed={comment.authorId}
                  />
                  <View style={styles.commentBody}>
                    <View style={styles.commentByline}>
                      <ThemedText type="titleSmall">{comment.authorName || profileName || t('post.unknownMember')}</ThemedText>
                      <ThemedText type="labelSmall" themeColor="faint">
                        {formatRelative(comment.createdAt, language)}
                      </ThemedText>
                    </View>
                    <ThemedText type="bodySmall" themeColor="secondary">
                      {comment.body}
                    </ThemedText>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>

          <View style={styles.composer}>
            <TextInput
              value={commentText}
              onChangeText={setCommentText}
              onSubmitEditing={handleSubmitComment}
              placeholder={t('post.details.commentPlaceholder')}
              placeholderTextColor={theme.faint}
              returnKeyType="send"
              style={[styles.composerInput, { color: theme.text, borderColor: theme.faint }]}
            />
            <FabButton
              icon={Icons.send}
              size={44}
              disabled={!commentText.trim()}
              onPress={handleSubmitComment}
              style={!commentText.trim() ? styles.composerSendDisabled : undefined}
            />
          </View>
        </KeyboardAvoider>
      </ThemedSafeAreaView>

      {/* Says which photo it's about, since it covers the one behind it,
          and why the reader is allowed to delete it at all — the rule is
          otherwise invisible. */}
      <ActionSheet
        visible={showActions}
        onClose={() => setShowActions(false)}
        title={authorName ? t('post.details.authorsPhoto', { name: authorName }) : t('post.details.thisPhoto')}
        subtitle={post ? `${formatDay(post.createdAt, language)} · ${circleName}` : undefined}
        avatarUri={photoUri}
        avatarRadius={Radius.input}
        options={[
          {
            label: t('post.details.deleteThisPhoto'),
            description: ownPost ? t('post.details.deleteBecauseYours') : t('post.details.deleteBecauseAdmin'),
            icon: Icons.deletePost,
            destructive: true,
            onPress: handleDelete,
          },
        ]}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  // The header keeps the screen's usual inset; the photo below runs edge
  // to edge, same as the album grid.
  headerInset: {
    paddingHorizontal: Spacing.screenPadding,
  },
  body: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: Spacing.cardListGap,
  },
  photo: {
    aspectRatio: PhotoAspect.post,
  },
  caption: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
  },
  byline: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Space.s100,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Space.s200,
  },
  bylineAlone: {
    paddingTop: Spacing.cardListGap,
  },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.s200,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
  },
  picker: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Space.s300,
  },
  reactors: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Space.s400,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.screenPadding,
    marginTop: Spacing.cardListGap + 4,
  },
  comments: {
    gap: Space.s400,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
  },
  commentRow: {
    flexDirection: 'row',
    gap: Space.s300,
  },
  commentByline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Space.s200,
  },
  commentBody: {
    flex: 1,
    gap: Space.s100,
    paddingTop: Space.s100,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
    paddingHorizontal: Spacing.screenPadding,
    paddingVertical: Space.s300,
  },
  composerInput: {
    flex: 1,
    height: 44,
    paddingHorizontal: Space.s400,
    borderRadius: 999,
    borderWidth: 1,
    fontFamily: Fonts.sans,
    fontSize: 14,
  },
  composerSendDisabled: {
    opacity: 0.4,
  },
});
