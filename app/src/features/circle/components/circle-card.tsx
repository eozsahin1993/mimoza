import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/ui/components/icon';
import { PhotoPlaceholder } from '@/ui/components/photo-placeholder';
import { ThemedText } from '@/ui/theme/themed-text';
import { Colors, Icons, Petal, Radius, Space } from '@/ui/theme/tokens';
import { useTints } from '@/ui/theme/hooks/use-theme';

export type CircleCardProps = {
  name: string;
  memberCount: number;
  /** Data URI of the actual cover photo, when it's known — otherwise the hatch placeholder shows. */
  photoUri?: string;
  /** Unread count shown as a "3 new" pill in the corner — omitted entirely once there's nothing new. */
  newCount?: number;
  /** Compact age of the newest photo, e.g. "2h" — sits beside the member count. */
  latestActivity?: string;
  onPress?: () => void;
};

export const CARD_HEIGHT = 100;

// The photo is the card, so everything on it is fixed light regardless of
// scheme, the same way the wordmark sits over the welcome photo. The scrim
// is what keeps that legible on a bright cover: clear across the top,
// dark by the bottom edge where the text is.
const ON_PHOTO = Colors.dark.text;
const SCRIM = ['rgba(20,16,12,0)', 'rgba(20,16,12,0.78)'] as const;

/**
 * The cover photo edge to edge, with the name and the two numbers that
 * matter laid over its bottom edge. What's new sits in the opposite
 * corner so it never crowds the name.
 */
export function CircleCard({ name, memberCount, photoUri, newCount, latestActivity, onPress }: CircleCardProps) {
  const { t } = useTranslation();
  const tints = useTints();
  return (
    <Pressable style={[styles.card, { borderColor: tints.cardEdge }]} onPress={onPress}>
      <PhotoPlaceholder style={StyleSheet.absoluteFill} />
      {photoUri ? <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
      <LinearGradient colors={SCRIM} locations={[0.4, 1]} style={StyleSheet.absoluteFill} />

      {newCount ? (
        <View style={styles.badge} accessibilityLabel={t('circle.newCount', { count: newCount })}>
          <ThemedText type="labelSmall" style={{ color: Colors.light.text }}>
            {newCount}
          </ThemedText>
        </View>
      ) : null}

      <View style={styles.footer}>
        <ThemedText type="titleLarge" numberOfLines={1} style={[styles.name, { color: ON_PHOTO }]}>
          {name}
        </ThemedText>

        <View style={styles.stats}>
          <View style={styles.stat} accessibilityLabel={t('circle.peopleCount', { count: memberCount })}>
            <Icon icon={Icons.members} size={14} color={ON_PHOTO} />
            <ThemedText type="labelMedium" style={{ color: ON_PHOTO }}>
              {memberCount}
            </ThemedText>
          </View>
          {latestActivity ? (
            <View style={styles.stat}>
              <Icon icon={Icons.waiting} size={14} color={ON_PHOTO} />
              <ThemedText type="labelMedium" style={{ color: ON_PHOTO }}>
                {latestActivity}
              </ThemedText>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    height: CARD_HEIGHT,
    borderRadius: Radius.circleCard,
    // A hairline so a dark cover, or the hatch in dark mode, still has an
    // edge against the background. On a light photo it is invisible.
    borderWidth: 1,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  // A count badge, not a chip: 20dp tall, round for one digit and a pill
  // from two, like every other unread count on the platform.
  badge: {
    position: 'absolute',
    top: Space.s300,
    right: Space.s300,
    height: Space.s500,
    minWidth: Space.s500,
    paddingHorizontal: Space.s100,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    backgroundColor: Petal,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
    paddingHorizontal: Space.s400,
    paddingBottom: Space.s200,
  },
  name: {
    flex: 1,
  },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s100,
  },
});
