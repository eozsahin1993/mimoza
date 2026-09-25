import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View, type ViewToken } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FabButton } from '@/ui/components/buttons/fab-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { EmptyFeedIcon } from '@/features/feed/components/empty-feed-icon';
import { gapBetween, stickyIndices, type FeedRow } from '@/features/feed/components/rows';
import { HeaderIconButton } from '@/ui/components/navbar/header-icon-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, Space, Spacing } from '@/ui/theme/tokens';
import { markCircleViewed } from '@/data/db';
import { useCircleFeed } from '@/features/feed/hooks/use-circle-feed';
import { useTheme } from '@/ui/theme/hooks/use-theme';

/** Scroll clearance above the FAB. The safe-area inset itself is separate — see `ListFooterComponent`. */
const LIST_BOTTOM_PADDING = 100;

/**
 * One circle's feed. `useCircleFeed` owns the data and the actions on it,
 * `buildFeedRows` decides what rows exist and in what order, and this
 * renders whatever comes back — so it has no idea what kinds of row there
 * are, and gains no branch when a new one is added.
 */
export default function FeedScreen() {
  const { t } = useTranslation();
  const { circleId, justJoined } = useLocalSearchParams<{ circleId: string; justJoined?: string }>();
  const openDetails = useCallback(
    () => router.push({ pathname: '/circle/details', params: { circleId } }),
    [circleId],
  );
  const theme = useTheme();
  const { rows, circleName, memberCount, loaded, refreshing, hasMore, loadingMore, loadMore, reload, refresh } = useCircleFeed(
    circleId,
    { justJoined: justJoined === '1' },
  );
  useFocusEffect(
    useCallback(() => {
      reload().catch((err) => console.error('Failed to load the feed', err));
      // A new post sorts to the top of the feed, so simply opening it is
      // genuine proof it was seen — unlike a comment, which can land on any
      // post regardless of age (see the viewability tracking below).
      if (circleId) markCircleViewed(circleId, Date.now()).catch((err) => console.error('Failed to mark the circle viewed', err));
    }, [circleId, reload]),
  );

  /**
   * Tells a row it has genuinely been on screen — what that means is the
   * row's own business (see `onSeen`). Deduped per screen instance: a row
   * sitting in view shouldn't fire on every viewability recompute.
   */
  const [seenRowKeys] = useState(() => new Set<string>());
  const [onViewableItemsChanged] = useState(
    () =>
      ({ viewableItems }: { viewableItems: ViewToken<FeedRow>[] }) => {
        for (const { item } of viewableItems) {
          if (!item.onSeen || seenRowKeys.has(item.key)) continue;
          seenRowKeys.add(item.key);
          item.onSeen();
        }
      },
  );
  const [viewabilityConfig] = useState(() => ({ itemVisiblePercentThreshold: 50 }));

  return (
    <ThemedView style={styles.screen}>
      {/* No bottom edge: the list runs to the true bottom of the screen so
          its last card's photo can bleed under the home indicator. */}
      <ThemedSafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        {/* Outside the list, like every other screen's header — so it
            stays put rather than scrolling, and the refresh spinner comes
            down from under it instead of over it. */}
        <View style={styles.headerInset}>
          <ScreenHeader
            title={circleName}
            subtitle={t('circle.feed.subtitle', { count: memberCount })}
            onPressTitle={openDetails}
            actions={
              <>
                <HeaderIconButton
                  icon={Icons.album}
                  accessibilityLabel={t('circle.feed.album')}
                  onPress={() => router.push({ pathname: '/circle/album', params: { circleId } })}
                />
                <HeaderIconButton icon={Icons.more} accessibilityLabel={t('circle.feed.details')} onPress={openDetails} />
              </>
            }
          />
        </View>

        <FlatList
          data={rows}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={theme.accent}
              colors={[theme.accent]}
            />
          }
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => item.render()}
          stickyHeaderIndices={stickyIndices(rows)}
          // Without this the first tap on send (next to an expanded post's
          // comment input) only dismisses the keyboard, so the comment
          // needs tapping twice.
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={({ leadingItem }: { leadingItem?: FeedRow }) => {
            if (!leadingItem) return null;
            const index = rows.indexOf(leadingItem);
            return <ThemedView style={{ height: gapBetween(leadingItem, rows[index + 1]) }} />;
          }}
          onEndReached={hasMore ? loadMore : undefined}
          onEndReachedThreshold={2}
          // Only once the first read has resolved — otherwise this flashes
          // before the feed arrives, same as the circle list's empty state.
          ListEmptyComponent={
            loaded ? (
              <View style={styles.empty}>
                <EmptyFeedIcon />
                <ThemedText type="titleMedium" style={styles.emptyTitle}>
                  {t('circle.feed.emptyTitle')}
                </ThemedText>
                <ThemedText type="bodyMedium" themeColor="muted" style={styles.emptyBody}>
                  {t('circle.feed.emptyBody')}
                </ThemedText>
                <SecondaryButton label={t('circle.feed.invitePeople')} onPress={openDetails} style={styles.emptyButton} />
              </View>
            ) : null
          }
          // Native padding, not `useSafeAreaInsets` — see the FAB's comment below.
          ListFooterComponent={
            <>
              {loadingMore ? <ActivityIndicator color={theme.muted} style={styles.loadingMore} /> : null}
              <SafeAreaView edges={['bottom']} />
            </>
          }
          contentContainerStyle={styles.list}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
        />
        {/* Native `SafeAreaView`, not `useSafeAreaInsets`: that hook's value
            can arrive a render late right after navigating, which would
            show as the FAB visibly snapping to its final position. */}
        <SafeAreaView edges={['bottom']} style={styles.fabAnchor} pointerEvents="box-none">
          <FabButton
            icon={Icons.composePost}
            onPress={() => router.push({ pathname: '/post/new', params: { circleId } })}
            style={styles.fab}
          />
        </SafeAreaView>
      </ThemedSafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  headerInset: {
    paddingHorizontal: Spacing.feedTextPadding,
  },
  list: {
    // On top of the header's own bottom margin: the first row is feed
    // content arriving under fixed chrome, not the next line of it.
    paddingTop: Spacing.cardListGap,
    paddingBottom: LIST_BOTTOM_PADDING,
    // Grows to fill the screen so the empty state's `flex: 1` has height
    // to centre itself in — see circle/index.tsx's empty state.
    flexGrow: 1,
  },
  loadingMore: {
    paddingVertical: Spacing.cardListGap,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.screenPadding,
    gap: Spacing.cardListGap,
  },
  emptyTitle: {
    textAlign: 'center',
  },
  emptyBody: {
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: Space.s100,
  },
  // Full width so the FAB still anchors bottom-right, without intercepting
  // touches over the rest of that width (see `pointerEvents` on the JSX).
  fabAnchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  fab: {
    position: 'absolute',
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
  },
});
