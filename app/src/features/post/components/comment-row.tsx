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
 * One comment, however many places show one: author and body inline on
 * one line — a comment is a reply, not a byline-and-caption pair — with
 * a relative timestamp of its own underneath, since the post it's on
 * already gives the absolute anchor.
 */
export function CommentRow({ authorName, authorPhotoUri, authorPublicKey, body, timestamp, size = DEFAULT_AVATAR_SIZE }: CommentRowProps) {
  return (
    <View style={styles.row}>
      <Avatar size={size} uri={authorPhotoUri} name={authorName} colorSeed={authorPublicKey} />
      <View style={styles.body}>
        <ThemedText type="bodySmall" themeColor="secondary">
          <ThemedText type="titleSmall">{authorName}</ThemedText>
          {'  '}
          {body}
        </ThemedText>
        <ThemedText type="labelSmall" themeColor="faint">
          {timestamp}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.s300,
  },
  body: {
    flex: 1,
    gap: Space.s100,
  },
});
