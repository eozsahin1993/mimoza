import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { CommentComposerBar } from '@/features/post/components/comment-composer-bar';
import { CommentRow } from '@/features/post/components/comment-row';
import { ThemedText } from '@/ui/theme/themed-text';
import { Space } from '@/ui/theme/tokens';

export type CommentItem = {
  id: string;
  authorName: string;
  /** Data URI of the author's picture, when known — otherwise their initials show. */
  authorPhotoUri?: string;
  /** Stabler than `authorName` for the avatar's colour — see `Avatar`'s `colorSeed` prop. */
  authorPublicKey?: string;
  body: string;
  /** Relative and short — "3d", "6h" — since the post's own timestamp already gives the absolute anchor. */
  timestamp: string;
};

export type PostCommentsProps = {
  /** The newest comment, the only one a card shows. */
  latest?: CommentItem;
  /** How many there are in all — the "Show all" link appears past one. */
  total: number;
  /** Revealed by the card's Comment button — a quiet post shows the chip row and nothing more. */
  composerOpen: boolean;
  onSubmit: (body: string) => void;
  /** Opens the post's own screen, where the whole thread lives. */
  onPressShowAll?: () => void;
  /** The reader's own picture — shown beside the composer, addressed to them. */
  selfPhotoUri?: string;
  /** Pairs with `selfPhotoUri` — the composer avatar's initials before a picture is set. */
  selfName?: string;
};

const AVATAR_SIZE = 30;

/**
 * The comment area under a feed post: the most recent comment, a way
 * into the rest, and the composer once the card's Comment button has
 * asked for it.
 *
 * Only ever one comment shown. A feed row is a photograph with a little context
 * under it, not a thread — the whole thread is one tap away on the post's
 * own screen, which is also the only place it can scroll independently of
 * the feed. The summary line is that tap.
 */
export function PostComments({
  latest,
  total,
  composerOpen,
  onSubmit,
  onPressShowAll,
  selfPhotoUri,
  selfName,
}: PostCommentsProps) {
  const { t } = useTranslation();

  return (
    <View style={styles.container}>
      {latest ? <CommentRow {...latest} size={AVATAR_SIZE} /> : null}

      {total > 1 ? (
        <Pressable style={styles.showAll} onPress={onPressShowAll} disabled={!onPressShowAll} hitSlop={6}>
          <ThemedText type="bodySmall" themeColor="secondary">
            {t('post.showAllComments', { count: total })}
          </ThemedText>
        </Pressable>
      ) : null}

      {composerOpen ? (
        <CommentComposerBar onSubmit={onSubmit} selfPhotoUri={selfPhotoUri} selfName={selfName} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Space.s300,
  },
  showAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s200,
  },
});
