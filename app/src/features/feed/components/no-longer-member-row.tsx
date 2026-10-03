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
import { ThemedView } from '@/ui/theme/themed-view';
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
    <ThemedView style={[styles.banner, { borderColor: tints.chipIdleBorder }]} type="surface">
      <Icon icon={Icons.archived} size={22} color={theme.muted} />
      <View style={styles.text}>
        <ThemedText type="titleMedium">{t('circle.archived.title')}</ThemedText>
        <ThemedText type="labelSmall" themeColor="muted">
          {t('circle.archived.body')}
        </ThemedText>
      </View>
      <Pressable onPress={() => confirmRemoveFromPhone(circleId, t)} hitSlop={8}>
        <ThemedText type="labelSmall" themeColor="accent">
          {t('circle.archived.removeRow')}
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: Spacing.feedTextPadding,
    marginTop: Spacing.gapBetweenPosts,
    padding: Space.s400,
    borderRadius: Radius.panel,
    borderWidth: 1,
    alignItems: 'center',
    gap: Space.s200,
  },
  text: {
    alignItems: 'center',
    gap: Space.s100,
  },
});
