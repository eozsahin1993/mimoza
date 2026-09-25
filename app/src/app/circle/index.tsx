import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { Avatar } from '@/ui/components/avatar/avatar';
import { Wordmark } from '@/ui/components/wordmark';
import { CircleCard } from '@/features/circle/components/circle-card';
import { CircleStatusRow } from '@/features/circle/components/circle-status-row';
import { JoinSheet } from '@/features/invite/components/join-sheet';
import { EmptyCirclesIcon } from '@/features/circle/components/empty-circles-icon';
import { FabButton } from '@/ui/components/buttons/fab-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { PrivacyInfoModal } from '@/features/account/components/privacy-info-modal';
import { PrivacyNotice } from '@/features/account/components/privacy-notice';
import { NotificationPromptDialog } from '@/features/push-notifications/components/notification-prompt-dialog';
import { answerNotificationPrompt, shouldOfferNotifications } from '@/features/push-notifications/usecases/enable-push';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, Space, Spacing } from '@/ui/theme/tokens';
import {
  countMembers,
  getFeed,
  getProfile,
  getUnreadCount,
  listCircles,
  listRequests,
  type Circle,
  type PendingRequest,
} from '@/data/db';
import { resolveCircleCoverUri } from '@/features/circle/usecases/circle-cover';
import { cancelPendingJoinRequest, checkPendingJoinRequest } from '@/features/invite/usecases/join-circle';
import { useOwnColorSeed } from '@/ui/theme/hooks/use-own-color-seed';
import { takePendingInviteCode } from '@/features/invite/services/pending-invite';
import { bytesToDataUri } from '@/core/photo/image';
import { formatRelative } from '@/core/utils/time';
import { upperCase } from '@/core/i18n/text';
import { nudgePhotoQueue } from '@/core/photo/photo-queue';
import { showError } from '@/core/services/messages';
import { syncCircles } from '@/core/sync/sync-circles';
import { useLanguage } from '@/core/i18n/use-language';

/** Scroll clearance above the FAB — see the same constant on circle/feed.tsx. */
const LIST_BOTTOM_PADDING = 100;

/**
 * Everything the list shows, headers included, so it is one FlatList that
 * windows every row rather than sections glued around it in header and
 * footer components. Built fresh each render from the three sources; an
 * empty source contributes nothing, not even its header.
 */
type ListItem =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'pending'; key: string; request: PendingRequest }
  | { kind: 'circle'; key: string; circle: CircleListItem }
  | { kind: 'locked'; key: string; circle: CircleListItem };

type CircleListItem = Circle & {
  memberCount: number;
  photoUri?: string;
  newCount: number;
  /** When the newest photo was added — null for a circle with none yet. */
  newestPostAt: number | null;
};

/**
 * The badge's count: posts and roster changes since this circle was last
 * opened, minus this account's own — see getUnreadCount.
 */
async function resolveUnreadCount(circle: Circle, myAccountId: string): Promise<number> {
  return getUnreadCount(circle.id, myAccountId);
}

export default function CircleListScreen() {
  const { t } = useTranslation();
  const language = useLanguage();
  const [avatarUri, setAvatarUri] = useState<string | undefined>();
  // Only for the header avatar's initials — the name isn't shown here.
  const [profileName, setProfileName] = useState<string | undefined>();
  const ownColorSeed = useOwnColorSeed();
  const [circles, setCircles] = useState<CircleListItem[]>([]);
  // A locked circle is one this device has no keys for yet, waiting on a
  // member to reseal them. It stays in the list, apart, because "where did
  // that circle go" is the question the section exists to answer.
  const open = circles.filter((circle) => !circle.needsRewrap);
  const locked = circles.filter((circle) => circle.needsRewrap);

  // Avoids flashing the empty state before the first load resolves.
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Circles asked for but not yet let into — shown above the real ones so
  // a request isn't invisible until you happen to reopen /join/pending.
  const [pending, setPending] = useState<PendingRequest[]>([]);
  // The invite code a link handed over, if any — the join sheet opens over
  // this screen rather than being a route of its own.
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);
  // The notification ask. The first screen after onboarding, and every
  // later one until it's answered either way.
  const [offerNotifications, setOfferNotifications] = useState(false);

  /** Re-reads the circle list from the local database. No network. */
  const loadFromDatabase = useCallback(async () => {
    const profile = await getProfile();
    setAvatarUri(profile?.picture ? bytesToDataUri(profile.picture) : undefined);
    setProfileName(profile?.name);
    // Empty rather than skipping the load: every current path into this
    // screen saves a local profile first, so this never actually matches
    // an authorId/actorId, but the list still has to render if it somehow
    // ran ahead of that.
    const myAccountId = profile?.accountId ?? '';

    // listCircles rather than getAllCircles: the latter is select(), so it
    // drags every circle's cover blob into JS on each focus. See circles.ts.
    const allCircles = await listCircles();
    const withCounts = await Promise.all(
      allCircles.map(async (circle) => {
        const [memberCount, photoUri, newCount, newest] = await Promise.all([
          countMembers(circle.id),
          resolveCircleCoverUri(circle.id),
          resolveUnreadCount(circle, myAccountId),
          getFeed(circle.id, 1),
        ]);
        // The newest post's own clock, for the row's timestamp. The
        // circle's lastEntryAt is the relay's and counts activity too.
        return { ...circle, memberCount, photoUri, newCount, newestPostAt: newest[0]?.createdAt ?? null };
      }),
    );
    setCircles(withCounts);
    setLoaded(true);
  }, []);

  /**
   * Completes any join whose approval has landed, reporting whether one
   * did. Callers reload on true: the circle a join produces is written
   * after this screen has already read the list, so without it the new
   * circle doesn't show until something else triggers a read.
   */
  const completePendingJoins = useCallback(async () => {
    const requests = await listRequests();
    setPending(requests);
    const results = await Promise.all(
      requests.map((request) =>
        checkPendingJoinRequest(request.circleId).catch((err: unknown) => {
          console.error('Failed to check a pending join request', err);
          return { state: 'pending' as const };
        }),
      ),
    );
    // Re-read rather than filtering locally: an approved ask is dropped
    // when its circle arrives, and a denied or aged-out one is gone too.
    if (results.some((result) => result.state !== 'pending')) {
      setPending(await listRequests());
    }
    return results.some((result) => result.state === 'approved');
  }, [setPending]);

  // On mount as well as on focus. A screen underneath a modal never gains
  // focus, so opening an invite link — which puts this screen up and a
  // sheet straight over it — would otherwise leave the list behind the
  // sheet empty, header and all, with circles sitting unread in SQLite.
  useEffect(() => {
    // Disabled rather than restructured: the state this sets lands in a
    // promise callback a query later, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFromDatabase().catch((err) => console.error('Failed to load circles', err));
    takePendingInviteCode()
      .then((code) => code && setJoinCode(code))
      .catch((err) => console.error('Failed to read a pending invite code', err));
    shouldOfferNotifications()
      .then(setOfferNotifications)
      .catch((err) => console.error('Failed to check notification permission', err));
  }, [loadFromDatabase]);

  const handleNotificationAnswer = useCallback((turnOn: boolean) => {
    setOfferNotifications(false);
    answerNotificationPrompt(turnOn).catch((err) => console.error('Failed to set up notifications', err));
  }, []);

  // Re-check on every focus, not just mount — picture/circles may have just
  // changed on a screen this one returns to (profile, new circle, a post).
  useFocusEffect(
    useCallback(() => {
      loadFromDatabase().catch((err) => console.error('Failed to load circles', err));

      // Opportunistically completes a join even if the user never reopens
      // /join/pending directly — the invite handshake can't depend on push
      // to tell the requester they were approved, so this same
      // app-lifecycle-triggered polling is what actually delivers it.
      completePendingJoins()
        .then((joined) => {
          if (joined) return loadFromDatabase();
        })
        .catch((err) => console.error('Failed to complete pending joins', err));
    }, [loadFromDatabase, completePendingJoins]),
  );

  const handleCancelPending = useCallback((request: PendingRequest) => {
    Alert.alert(t('circle.list.cancelPendingTitle', { name: request.circleName }), t('circle.list.cancelPendingMessage'), [
      { text: t('circle.list.keepWaiting'), style: 'cancel' },
      {
        text: t('circle.list.cancelRequest'),
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelPendingJoinRequest(request.circleId);
          } catch (err) {
            console.error('Failed to withdraw join request', err);
          }
          setPending(await listRequests());
        },
      },
    ]);
  }, [t, setPending]);

  /** Syncs every circle, then re-reads. Photos are left to their own queue. */
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Before the sync, so a circle this pull just joined is synced by the
      // same pull rather than sitting empty until the next one. Pulling to
      // refresh is the obvious thing to do while waiting to be let in, and
      // it used to be the one gesture that couldn't complete a join.
      await completePendingJoins().catch((err) => console.error('Failed to complete pending joins', err));

      const failed = await syncCircles({ force: true });
      nudgePhotoQueue();
      if (failed > 0) showError(t('circle.list.refreshFailed'));
    } finally {
      await loadFromDatabase().catch((err) => console.error('Failed to reload circles', err));
      setRefreshing(false);
    }
  }, [loadFromDatabase, completePendingJoins, t]);

  const items: ListItem[] = [];
  if (pending.length) {
    items.push({ kind: 'header', key: 'header-pending', title: t('circle.list.waitingToJoin') });
    for (const request of pending) items.push({ kind: 'pending', key: `pending-${request.circleId}`, request });
  }
  if (open.length) {
    items.push({ kind: 'header', key: 'header-circles', title: t('circle.list.yourCircles') });
    for (const circle of open) items.push({ kind: 'circle', key: `circle-${circle.id}`, circle });
  }
  if (locked.length) {
    items.push({ kind: 'header', key: 'header-locked', title: t('circle.list.locked') });
    for (const circle of locked) items.push({ kind: 'locked', key: `locked-${circle.id}`, circle });
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Wordmark withBloom accessibilityRole="header" accessibilityLabel="mimoza" />

          <Pressable onPress={() => router.push('/account')}>
            <Avatar size={44} uri={avatarUri} name={profileName} colorSeed={ownColorSeed} />
          </Pressable>
        </View>

        <FlatList
          data={loaded ? items : []}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          keyExtractor={(item) => item.key}
          ListHeaderComponent={<PrivacyNotice onPress={() => setShowPrivacyInfo(true)} style={styles.privacyNotice} />}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            switch (item.kind) {
              case 'header':
                return (
                  <ThemedText type="code" themeColor="muted" style={styles.sectionTitle}>
                    {upperCase(item.title, language)}
                  </ThemedText>
                );
              case 'pending':
                return (
                  <CircleStatusRow
                    icon={Icons.waiting}
                    name={item.request.circleName}
                    status={t('circle.list.pendingStatus')}
                    actionLabel={t('common.cancel')}
                    onAction={() => handleCancelPending(item.request)}
                    onPress={() => router.push({ pathname: '/join/pending', params: { circleId: item.request.circleId } })}
                  />
                );
              case 'circle':
                return (
                  <CircleCard
                    name={item.circle.name}
                    memberCount={item.circle.memberCount}
                    photoUri={item.circle.photoUri}
                    newCount={item.circle.newCount}
                    latestActivity={
                      item.circle.newestPostAt === null ? undefined : formatRelative(item.circle.newestPostAt, language)
                    }
                    onPress={() => router.push({ pathname: '/circle/feed', params: { circleId: item.circle.id } })}
                  />
                );
              case 'locked':
                return <CircleStatusRow icon={Icons.locked} name={item.circle.name} status={t('circle.list.lockedStatus')} />;
            }
          }}
          // Only once the first read has resolved — otherwise the empty
          // state flashes before the circles arrive.
          // Not while a request is pending: the header already says what
          // is happening, and "no circles yet" under it reads as a denial.
          ListEmptyComponent={
            loaded && !items.length ? (
              <View style={styles.empty}>
                <EmptyCirclesIcon />
                <ThemedText type="titleMedium" style={styles.emptyTitle}>
                  {t('circle.list.emptyTitle')}
                </ThemedText>
                <ThemedText type="bodyMedium" themeColor="muted" style={styles.emptyBody}>
                  {t('circle.list.emptyBody')}
                </ThemedText>
                <SecondaryButton label={t('circle.list.createCircle')} onPress={() => router.push('/circle/new')} style={styles.emptyButton} />
              </View>
            ) : null
          }
        />

        <FabButton
          icon={Icons.add}
          onPress={() => router.push('/circle/new')}
          style={styles.fab}
        />
      </ThemedSafeAreaView>

      <JoinSheet
        code={joinCode}
        onClose={() => setJoinCode(null)}
        onRequested={() => {
          listRequests()
            .then(setPending)
            .catch((err: unknown) => console.error('Failed to reload pending requests', err));
        }}
      />

      {/* Held back while an invite's join sheet is up, so it follows the
          request: then the reason can name who they're waiting on. */}
      <NotificationPromptDialog
        visible={offerNotifications && !joinCode}
        waitingOn={pending[0]}
        onTurnOn={() => handleNotificationAnswer(true)}
        onNotNow={() => handleNotificationAnswer(false)}
      />

      <PrivacyInfoModal visible={showPrivacyInfo} onClose={() => setShowPrivacyInfo(false)} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.topPadUnderSafeArea,
    gap: Spacing.cardListGap,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  list: {
    // Grows to fill the screen so the empty state's `flex: 1` still has
    // height to centre itself in — a content container is otherwise only
    // as tall as its content, leaving the message pinned under the header.
    flexGrow: 1,
    gap: Spacing.cardListGap,
    // Reserved unconditionally — a full screen of circles must clear the
    // FAB at the bottom exactly as a short one does, not just enough to
    // avoid the last row's own padding but the FAB's full footprint.
    paddingBottom: LIST_BOTTOM_PADDING,
  },
  privacyNotice: {
    paddingHorizontal: Space.s0,
    paddingBottom: Space.s200,
  },
  // The `code` type is sized for an invite code standing on its own; as a
  // section label it only wants the face and the tracking.
  sectionTitle: {
    fontSize: 12,
    lineHeight: 12 * 1.3,
    letterSpacing: 12 * 0.13,
    marginTop: Space.s200,
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
  fab: {
    position: 'absolute',
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
  },
});
