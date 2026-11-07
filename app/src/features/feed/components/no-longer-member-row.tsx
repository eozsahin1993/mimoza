import { router } from 'expo-router';
import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { FeedRow, FeedRows } from '@/features/feed/components/rows';
import { showAlert } from '@/core/services/alerts';
import { showError } from '@/core/services/messages';
import { purgeCircleLocally } from '@/features/circle/usecases/purge-circle';
import { Icon } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { Icons, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

export type NoLongerMemberRowsInput = {
  circleId: string;
  /** This account is no longer in the circle — see `CircleFeedMeta.readOnly`. */
  readOnly: boolean;
};

/**
 * Pinned above everything in an archived circle: what this feed now is,
 * and the one thing that can still be done with it. The reason is not
 * named because the device cannot know it — the relay stops listing the
 * circle, nothing more — and "no longer in" is true whether an admin
 * removed this account or it left from another phone.
 */
export function useNoLongerMemberRows({ circleId, readOnly }: NoLongerMemberRowsInput): FeedRows {
  return useMemo(() => ({ rows: readOnly ? [noLongerMemberRow(circleId)] : [] }), [circleId, readOnly]);
}

export function noLongerMemberRow(circleId: string): FeedRow {
  return {
    key: 'no-longer-member',
    spacing: Spacing.gapBetweenPosts,
    render: () => <NoLongerMemberBanner circleId={circleId} />,
  };
}

/** Confirms, purges, and leaves the screen — the same action details offers. */
export function confirmRemoveFromPhone(circleId: string, t: TFunction): void {
  showAlert(t('circle.archived.removeTitle'), t('circle.archived.removeMessage'), [
    { text: t('common.cancel'), style: 'cancel' },
    {
      text: t('circle.archived.removeConfirm'),
      style: 'destructive',
      onPress: async () => {
        try {
          await purgeCircleLocally(circleId);
          router.dismissTo('/circle');
        } catch (err) {
          console.error('Failed to remove the circle from this phone', err);
          showError(t('circle.archived.removeFailed'));
        }
      },
    },
  ]);
}

function NoLongerMemberBanner({ circleId }: { circleId: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();

  return (
    <View style={[styles.banner, { backgroundColor: tints.privacyWashBg, borderColor: tints.privacyWashBorder }]}>
      <View style={styles.notice}>
        <View style={[styles.iconDisc, { backgroundColor: tints.chipIdleBg }]}>
          <Icon icon={Icons.archive} size={18} color={theme.muted} />
        </View>
        <View style={styles.text}>
          <ThemedText type="titleSmall">{t('circle.archived.title')}</ThemedText>
          <ThemedText type="bodySmall">{t('circle.archived.body')}</ThemedText>
        </View>
      </View>
      <View style={[styles.divider, { backgroundColor: tints.privacyWashBorder }]} />
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
        onPress={() => confirmRemoveFromPhone(circleId, t)}>
        <Icon icon={Icons.delete} size={18} color={theme.danger} />
        <ThemedText type="labelMedium" themeColor="danger">
          {t('circle.archived.removeRow')}
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: Spacing.feedTextPadding,
    marginTop: Spacing.gapBetweenPosts,
    borderRadius: Radius.panel,
    borderWidth: 1,
  },
  notice: {
    flexDirection: 'row',
    padding: Space.s400,
    gap: Space.s300,
  },
  iconDisc: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: Space.s100,
  },
  divider: {
    height: 1,
  },
  remove: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Space.s300,
    paddingHorizontal: Space.s400,
    gap: Space.s200,
  },
  pressed: {
    opacity: 0.6,
  },
});
