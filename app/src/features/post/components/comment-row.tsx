import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/ui/components/avatar/avatar';
import { ThemedText } from '@/ui/theme/themed-text';
import { Space } from '@/ui/theme/tokens';
import type { CommentItem } from '@/features/post/components/post-comments';

export type CommentRowProps = Omit<CommentItem, 'id'> & {
  /** The feed card's compact size by default — the post's own thread asks for something larger. */
  size?: number;
};

const DEFAULT_AVATAR_SIZE = 30;

/**
 * One comment, however many places show one: author and time on a
 * byline, the comment itself on its own line below — a reply reads as a
 * small message, not a caption with a name run into it.
 */
export function CommentRow({ authorName, authorPhotoUri, authorPublicKey, body, timestamp, size = DEFAULT_AVATAR_SIZE }: CommentRowProps) {
  return (
    <View style={styles.row}>
      <Avatar size={size} uri={authorPhotoUri} name={authorName} colorSeed={authorPublicKey} />
      <View style={styles.body}>
        <View style={styles.byline}>
          <ThemedText type="titleSmall" numberOfLines={1} style={[styles.authorName, styles.bylineText]}>
            {authorName}
          </ThemedText>
          <ThemedText type="labelSmall" themeColor="faint" style={styles.bylineText}>
            {timestamp}
          </ThemedText>
        </View>
        <ThemedText type="bodySmall" themeColor="secondary">
          {body}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Space.s300,
  },
  body: {
    flex: 1,
    gap: Space.s0,
    marginTop: 0,
  },
  byline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Space.s200,
  },
  authorName: {
    flexShrink: 1,
  },
  bylineText: {
    includeFontPadding: false,
  },
});
