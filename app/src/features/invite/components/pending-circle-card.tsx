import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { CARD_HEIGHT } from '@/features/circle/components/circle-card';
import { Icon } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { Icons, Radius, Space } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { formatAgo } from '@/core/utils/time';
import { useLanguage } from '@/core/i18n/use-language';

export type PendingCircleCardProps = {
  circleName: string;
  /** The invite creator's self-reported name — blank until the preview decodes, so the copy falls back. */
  createdByName: string;
  /** When this device submitted the request, for the "asked …" half of the line. */
  submittedAt: number;
  onPress?: () => void;
  onCancel?: () => void;
};

/**
 * A circle asked for but not yet joined.
 *
 * Built to `CircleCard`'s silhouette — same height, same corner, same
 * square leading slot — because the two sit in one list and anything else
 * reads as a different kind of thing rather than the same thing waiting.
 * The icon stands where the cover photo goes, which is what this is: a
 * circle with nothing to show yet.
 *
 * Dashed rather than solid is the one difference that carries meaning —
 * the outline says placeholder, not a circle that failed to load. Cancel
 * sits on the row itself because withdrawing is the only other thing you
 * can do here, and burying it behind a tap would make waiting feel like
 * the only option.
 */
export function PendingCircleCard({ circleName, createdByName, submittedAt, onPress, onCancel }: PendingCircleCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  const language = useLanguage();

  return (
    <Pressable
      style={[styles.card, { borderColor: tints.raisedBorder, backgroundColor: tints.chipIdleBg }]}
      onPress={onPress}>
      <View style={styles.leading}>
        <Icon icon={Icons.waiting} size={22} color={theme.muted} />
      </View>

      <View style={styles.content}>
        <ThemedText type="titleMedium" numberOfLines={1}>
          {circleName}
        </ThemedText>
        <ThemedText type="labelSmall" themeColor="muted" numberOfLines={2}>
          {createdByName
            ? t('invite.card.waitingOn', { name: createdByName, ago: formatAgo(submittedAt, language) })
            : t('invite.card.waitingOnUnknown', { ago: formatAgo(submittedAt, language) })}
        </ThemedText>
      </View>

      {onCancel ? (
        <Pressable onPress={onCancel} hitSlop={12} style={styles.cancel}>
          <ThemedText type="bodyMedium" themeColor="secondary">
            {t('common.cancel')}
          </ThemedText>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    // No minHeight: the line below the name is capped at two, so this can't
    // outgrow the card beside it and break the list's rhythm.
    height: CARD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.circleCard,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  leading: {
    width: CARD_HEIGHT,
    height: CARD_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    padding: Space.s300,
    justifyContent: 'center',
    gap: Space.s100,
  },
  cancel: {
    paddingHorizontal: Space.s400,
  },
});
