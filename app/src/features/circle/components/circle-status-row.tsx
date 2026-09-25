import { Pressable, StyleSheet } from 'react-native';

import { Icon } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { Radius, Space } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import type { ComponentProps } from 'react';

export type CircleStatusRowProps = {
  icon: ComponentProps<typeof Icon>['icon'];
  name: string;
  /** Why it isn't openable, in a few words — it gives way first when the row is too narrow. */
  status: string;
  actionLabel?: string;
  onAction?: () => void;
  onPress?: () => void;
};

/**
 * A circle that can't be opened yet: waiting to be let in, or waiting for
 * its keys.
 *
 * Deliberately not CircleCard's silhouette. These have no cover, no
 * unread count and often nothing behind a tap, so giving them a card's
 * weight reads as a circle that failed to load rather than one that isn't
 * ready. A plain surface with no border is what makes it read as a note
 * in the list rather than a thing in it.
 */
export function CircleStatusRow({ icon, name, status, actionLabel, onAction, onPress }: CircleStatusRowProps) {
  const theme = useTheme();
  const tints = useTints();

  return (
    <Pressable disabled={!onPress} onPress={onPress} style={[styles.row, { backgroundColor: theme.surface, borderColor: tints.cardEdge }]}>
      {/* Same size as the stat icons on CircleCard, so the two rhyme. */}
      <Icon icon={icon} size={16} color={theme.muted} />
      {/* One Text, so the name and the status truncate as a single line and
          the status is what gets cut. Same face and size for both; only the
          colour separates them. */}
      <ThemedText numberOfLines={1} style={styles.label} type="bodyLarge">
        {name}
        <ThemedText themeColor="muted" type="bodySmall">{` · ${status}`}</ThemedText>
      </ThemedText>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={12}>
          <ThemedText>{actionLabel}</ThemedText>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s200,
    // The cards' corner, so the two shapes in one list rhyme.
    borderRadius: Radius.circleCard,
    borderWidth: 1,
    paddingHorizontal: Space.s400,
    paddingVertical: Space.s300,
  },
  label: {
    flex: 1,
  },
});
