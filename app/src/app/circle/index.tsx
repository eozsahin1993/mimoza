import { bytesToHex } from '@noble/curves/utils.js';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { Avatar } from '@/ui/components/avatar/avatar';
import { Wordmark } from '@/ui/components/wordmark';
import { CircleCard } from '@/features/circle/components/circle-card';
import { JoinSheet } from '@/features/invite/components/join-sheet';
import { PendingCircleCard } from '@/features/invite/components/pending-circle-card';
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
import { getCircleIdentity } from '@/core/services/keystore/circle-keys';
import { bytesToDataUri } from '@/core/photo/image';
import { formatAgo } from '@/core/utils/time';
import { nudgePhotoQueue } from '@/core/photo/photo-queue';
import { showError } from '@/core/services/messages';
import { syncCircles } from '@/core/sync/sync-circles';
import { useLanguage } from '@/core/i18n/use-language';

type CircleListItem = Circle & {
  memberCount: number;
  photoUri?: string;
  newCount: number;
  /** When the newest photo was added — null for a circle with none yet. */
  newestPostAt: number | null;
};

/**
 * The unread badge's count — 0 (not shown at all) whenever this device has
 * Everything newer than the last time this circle was opened — posts and
 * roster changes alike, which is what the row's dot counts.
 */
async function resolveUnreadCount(circle: Circle): Promise<number> {
  return getUnreadCount(circle.id);
}

export default function CircleListScreen() {
  const { t } = useTranslation();
  const language = useLanguage();
  const [avatarUri, setAvatarUri] = useState<string | undefined>();
  // Only for the header avatar's initials — the name isn't shown here.
  const [profileName, setProfileName] = useState<string | undefined>();
  const ownColorSeed = useOwnColorSeed();
  const [circles, setCircles] = useState<CircleListItem[]>([]);
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

    // listCircles rather than getAllCircles: the latter is select(), so it
    // drags every circle's cover blob into JS on each focus. See circles.ts.
    const allCircles = await listCircles();
    const withCounts = await Promise.all(
      allCircles.map(async (circle) => {
        const [memberCount, photoUri, newCount, newest] = await Promise.all([
          countMembers(circle.id),
          resolveCircleCoverUri(circle.id),
          resolveUnreadCount(circle),
          getFeed(circle.id, 1),
        ]);
        // The newest post's own clock, for the row's timestamp. The
        // circle's lastEntryAt is the relay's and counts activity too.
        return { ...circle, memberCount, photoUri, newCount, newestPostAt: newest[0]?.createdAt ?? 0 };
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
  }, []);

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
  }, [t]);

  /** Syncs every circle, then re-reads. Photos are left to their own queue. */
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Before the sync, so a circle this pull just joined is synced by the
      // same pull rather than sitting empty until the next one. Pulling to
      // refresh is the obvious thing to do while waiting to be let in, and
      // it used to be the one gesture that couldn't complete a join.
      await completePendingJoins().catch((err) => console.error('Failed to complete pending joins', err));

      const failed = await syncCircles();
      nudgePhotoQueue();
      if (failed > 0) showError(t('circle.list.refreshFailed'));
    } finally {
      await loadFromDatabase().catch((err) => console.error('Failed to reload circles', err));
      setRefreshing(false);
    }
  }, [loadFromDatabase, completePendingJoins, t]);

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
          data={loaded ? circles : []}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          keyExtractor={(circle) => circle.id}
          ListHeaderComponent={
            <>
              <PrivacyNotice onPress={() => setShowPrivacyInfo(true)} style={styles.privacyNotice} />
              {pending.length ? (
                <View style={styles.pending}>
                  <ThemedText type="labelMedium">
                    {t('circle.list.waitingToJoin', { count: pending.length })}
                  </ThemedText>
                  {pending.map((request) => (
                    <PendingCircleCard
                      key={request.circleId}
                      circleName={request.circleName}
                      createdByName={request.invitedByName}
                      submittedAt={request.submittedAt}
                      onPress={() => router.push({ pathname: '/join/pending', params: { circleId: request.circleId } })}
                      onCancel={() => handleCancelPending(request)}
                    />
                  ))}
                </View>
              ) : null}
              {loaded && circles.length ? (
                <ThemedText type="labelMedium" style={styles.sectionTitle}>
                  {t('circle.list.yourCircles')}
                </ThemedText>
              ) : null}
            </>
          }
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <CircleCard
              name={item.name}
              memberCount={item.memberCount}
              photoUri={item.photoUri}
              newCount={item.newCount}
              latestActivity={
                item.newestPostAt === null
                  ? undefined
                  : t('circle.lastAdded', { ago: formatAgo(item.newestPostAt, language) })
              }
              onPress={() => router.push({ pathname: '/circle/feed', params: { circleId: item.id } })}
            />
          )}
          // Only once the first read has resolved — otherwise the empty
          // state flashes before the circles arrive.
          // Not while a request is pending: the header already says what
          // is happening, and "no circles yet" under it reads as a denial.
          ListEmptyComponent={
            loaded && !pending.length ? (
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
    paddingBottom: Spacing.cardListGap,
  },
  privacyNotice: {
    paddingHorizontal: Space.s0,
    paddingBottom: Space.s200,
  },
  sectionTitle: {
    marginTop: Space.s200,
  },
  pending: {
    gap: Space.s300,
    paddingBottom: Space.s200,
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
