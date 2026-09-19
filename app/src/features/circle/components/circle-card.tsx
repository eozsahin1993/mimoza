import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/ui/components/icon';
import { PhotoPlaceholder } from '@/ui/components/photo-placeholder';
import { ThemedText } from '@/ui/theme/themed-text';
import { Icons, Radius, Space } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

export type CircleCardProps = {
  name: string;
  memberCount: number;
  /** Data URI of the actual cover photo, when it's known — otherwise the hatch placeholder shows. */
  photoUri?: string;
  /** Unread count shown as a "3 new" pill next to the name — omitted entirely once there's nothing new. */
  newCount?: number;
  /** Most recent activity line, e.g. "Last added 6 days ago" — its own row under the member count. */
  latestActivity?: string;
  onPress?: () => void;
};

/** Exported so the pending card can hold the same silhouette in the list. */
export const CARD_HEIGHT = 92;

/**
 * A real card, not a photo with text laid over it — the cover gets a
 * full-height square (bigger than the old 84px thumbnail) on its own,
 * and the name, member count and activity sit on the card's own surface
 * beside it, so the photo can be emphasized without having to also stay
 * legible as a backdrop for white text.
 */
export function CircleCard({ name, memberCount, photoUri, newCount, latestActivity, onPress }: CircleCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  return (
    <Pressable
      style={[styles.card, { backgroundColor: theme.surface, borderColor: tints.raisedBorder }]}
      onPress={onPress}>
      {photoUri ? (
        <Image source={{ uri: photoUri }} style={styles.cover} contentFit="cover" />
      ) : (
        <PhotoPlaceholder style={styles.cover} />
      )}

      <View style={styles.content}>
        <View style={styles.titleRow}>
          <ThemedText type="titleMedium" numberOfLines={1} style={styles.title}>
            {name}
          </ThemedText>
          {newCount ? (
            <View style={[styles.badge, { backgroundColor: tints.chipReactedBg }]}>
              <ThemedText type="labelSmall" themeColor="accentBright">
                {t('circle.newCount', { count: newCount })}
              </ThemedText>
            </View>
          ) : null}
        </View>

        <View style={styles.metaRow}>
          <Icon icon={Icons.members} size={14} color={theme.muted} />
          <ThemedText type="labelSmall" themeColor="muted" numberOfLines={1}>
            {t('circle.peopleCount', { count: memberCount })}
          </ThemedText>
        </View>

        {latestActivity ? (
          <ThemedText type="labelSmall" themeColor="faint" numberOfLines={1}>
            {latestActivity}
          </ThemedText>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    height: CARD_HEIGHT,
    flexDirection: 'row',
    borderRadius: Radius.circleCard,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cover: {
    width: CARD_HEIGHT,
    height: CARD_HEIGHT,
  },
  content: {
    flex: 1,
    padding: Space.s300,
    justifyContent: 'center',
    gap: Space.s100,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s200,
  },
  title: {
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s200,
  },
  badge: {
    paddingHorizontal: Space.s300,
    paddingVertical: Space.s100,
    borderRadius: Radius.pill,
  },
});
