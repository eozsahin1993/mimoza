import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';

import type { FeedRow, FeedRows } from '@/features/feed/components/rows';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTints } from '@/ui/theme/hooks/use-theme';

export type JustJoinedRowsInput = {
  /** Whether this arrival was a join at all — the route carries that, not the feed. */
  justJoined: boolean;
  /** How much history has landed. The banner is only honest while there is none. */
  postCount: number;
};

/**
 * A fresh joiner has the circle secret and roster access but no history
 * yet — pulling an existing circle's past entries from the relay isn't
 * built, so there's nothing to backfill from. Honest about the gap rather
 * than looking broken.
 *
 * Both halves of "should this show" live here, and neither is a condition
 * the coordinator has to remember: empty when it shouldn't show.
 */
export function useJustJoinedRows({ justJoined, postCount }: JustJoinedRowsInput): FeedRows {
  return useMemo(() => ({ rows: justJoined && postCount === 0 ? [justJoinedRow()] : [] }), [justJoined, postCount]);
}

export function justJoinedRow(): FeedRow {
  return {
    key: 'just-joined',
    spacing: Spacing.gapBetweenPosts,
    render: () => <JustJoinedBanner />,
  };
}

function JustJoinedBanner() {
  const { t } = useTranslation();
  const tints = useTints();

  return (
    <ThemedView style={[styles.banner, { borderColor: tints.chipIdleBorder }]} type="surface">
      <ThemedText type="titleMedium">{t('feed.justJoinedTitle')}</ThemedText>
      <ThemedText type="labelSmall" themeColor="muted">
        {t('feed.justJoinedBody')}
      </ThemedText>
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
    gap: Space.s100,
  },
});
