import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AppState, Pressable, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Space, Spacing } from '@/ui/theme/tokens';
import { getRequest } from '@/data/db';
import { cancelPendingJoinRequest, checkPendingJoinRequest } from '@/features/invite/usecases/join-circle';

/**
 * Faster than the sync scheduler's 30s: this is someone watching a screen
 * for one specific answer, not background housekeeping.
 */
const CHECK_INTERVAL_MS = 5_000;

export default function JoinPendingScreen() {
  const { t } = useTranslation();
  // Keyed by circle, not by request: an ask is one per circle, and the
  // relay's circle list is what answers it.
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circleName, setCircleName] = useState('');
  const [inviterName, setInviterName] = useState('');
  const [gone, setGone] = useState(false);

  // Polled while this screen is up, not only on focus. Focus alone meant
  // the one screen whose entire job is waiting never noticed the thing it
  // was waiting for: staying put fires nothing, and returning from the
  // background fires nothing either, since navigation focus was never
  // lost. Approval arrived and the screen kept saying "waiting" until you
  // navigated away and back.
  //
  // Never dependent on push arriving — approval must complete even if
  // notifications are disabled or the platform never delivers one. Also
  // survives the app being closed and reopened entirely:
  // `pendingJoinRequests` is the local source for `circleName` below, not
  // component state carried from the previous screen.
  useFocusEffect(
    useCallback(() => {
      if (!circleId) return;

      getRequest(circleId).then((pending) => {
        if (!pending) {
          setGone(true);
          return;
        }
        setCircleName(pending.circleName);
        setInviterName(pending.invitedByName);
      });

      let stopped = false;
      const check = () => {
        if (stopped) return;
        checkPendingJoinRequest(circleId)
          .then((result) => {
            if (stopped) return;
            if (result.state === 'approved') {
              stopped = true;
              router.replace({ pathname: '/circle/feed', params: { circleId: result.circleId, justJoined: '1' } });
              return;
            }
            // Denied, or aged out. Nothing will ever answer it, so say so
            // rather than leaving this screen waiting indefinitely.
            if (result.state === 'gone') {
              stopped = true;
              setGone(true);
            }
          })
          .catch((err) => console.error('Failed to check pending join request', err));
      };

      check();
      const interval = setInterval(check, CHECK_INTERVAL_MS);
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') check();
      });

      return () => {
        stopped = true;
        clearInterval(interval);
        subscription.remove();
      };
    }, [circleId]),
  );

  function handleCancel() {
    if (!circleId) return;
    Alert.alert(t('invite.pending.withdrawTitle'), t('invite.pending.withdrawMessage'), [
      { text: t('invite.pending.keepWaiting'), style: 'cancel' },
      {
        text: t('invite.pending.withdrawConfirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelPendingJoinRequest(circleId);
          } catch (err) {
            console.error('Failed to withdraw join request', err);
          }
          router.dismissTo('/circle');
        },
      },
    ]);
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('invite.pending.title')} />

        <View style={styles.content}>
          {gone ? (
            <>
              <ThemedText type="headlineSmall">{t('invite.pending.goneTitle')}</ThemedText>
              <ThemedText type="bodyMedium" themeColor="secondary" style={styles.body}>
                {t('invite.pending.goneBody')}
              </ThemedText>
            </>
          ) : (
            <>
              <View>
                <ThemedText type="labelMedium">{t('invite.pending.waiting')}</ThemedText>
                <ThemedText type="headlineSmall">{circleName}</ThemedText>
              </View>
              <ThemedText type="bodyMedium" themeColor="secondary" style={styles.body}>
                {inviterName
                  ? t('invite.pending.letYouIn', { name: inviterName })
                  : t('invite.pending.letYouInUnknown')}
              </ThemedText>

              <Pressable onPress={handleCancel} style={styles.cancel}>
                <ThemedText type="bodyMedium" themeColor="danger">
                  {t('invite.pending.withdraw')}
                </ThemedText>
              </Pressable>
            </>
          )}
        </View>
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
    paddingHorizontal: Spacing.screenPadding,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.cardListGap,
  },
  body: {
    marginTop: -8,
  },
  cancel: {
    alignSelf: 'flex-start',
    paddingVertical: Space.s200,
  },
});
