import * as Device from 'expo-device';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Colors, Radius, Space, Spacing } from '@/ui/theme/tokens';
import {
  checkDeviceTransfer,
  startDeviceTransfer,
  type PendingDeviceTransfer,
} from '@/features/account/usecases/device-transfer';
import { useTints } from '@/ui/theme/hooks/use-theme';
import { showDone, showError } from '@/core/services/messages';

const POLL_INTERVAL_MS = 2_000;
const QR_SIZE = 220;

/**
 * The waiting device's half of a transfer: publish a one-time public key,
 * draw it, and poll until the other phone seals this account to it.
 *
 * This device shows the code rather than scanning one, which is a
 * security property rather than a layout choice — see
 * `DeviceTransferQrPayload`. What's on screen here is worthless to anyone
 * who photographs it.
 */
export default function DeviceTransferScreen() {
  const { t } = useTranslation();
  const tints = useTints();
  const [pending, setPending] = useState<PendingDeviceTransfer | null>(null);
  const [failed, setFailed] = useState(false);
  // Refs, not state: the interval closes over its first render, and a
  // slow collect can still be running when the next tick fires.
  const done = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    startDeviceTransfer(Device.modelName ?? t('account.transfer.unnamedDevice'))
      .then((started) => !cancelled && setPending(started))
      .catch((err) => {
        console.error('Failed to start a device transfer', err);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
    // Mount only: re-running on a language change would start a second transfer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pending) return;

    const timer = setInterval(async () => {
      if (done.current || inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await checkDeviceTransfer(pending);
        if (!result.transferred) return;

        done.current = true;
        showDone(t('account.transfer.broughtOver', { count: result.circleCount }));
        router.replace('/circle');
      } catch (err) {
        console.error('Failed to complete a device transfer', err);
        done.current = true;
        showError(t('account.transfer.failed'));
        setFailed(true);
      } finally {
        inFlight.current = false;
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [pending, t]);

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('account.transfer.header')} />

        <View style={styles.content}>
          <ThemedText type="bodyMedium" themeColor="secondary">
            {t('account.transfer.instructions')}
          </ThemedText>

          <View style={[styles.qrFrame, { borderColor: tints.chipIdleBorder }]}>
            {/*
              Fixed dark-ink-on-light-plate regardless of scheme, not theme-reactive
              — the same reasoning as invite-sheet.tsx's QR: plenty of scanners
              still refuse an inverted (light-on-dark) code.
            */}
            <View style={styles.qrPlate}>
              {pending ? (
                <QRCode
                  value={JSON.stringify(pending.qr)}
                  size={QR_SIZE}
                  backgroundColor={Colors.dark.accentBright}
                  color={Colors.dark.background}
                />
              ) : (
                <ActivityIndicator color={Colors.dark.background} />
              )}
            </View>
          </View>

          {failed ? (
            <ThemedText type="labelSmall" themeColor="muted" style={styles.status}>
              {t('account.transfer.somethingWrong')}
            </ThemedText>
          ) : (
            <ThemedText type="labelSmall" themeColor="muted" style={styles.status}>
              {t('account.transfer.waiting')}
            </ThemedText>
          )}

          <View style={styles.spacer} />

          <ThemedText type="labelSmall" themeColor="faint">
            {t('account.transfer.reassurance')}
          </ThemedText>

          <Pressable style={styles.noOtherPhone} onPress={() => router.replace('/account/restore')}>
            <ThemedText type="labelLarge" themeColor="accentBright">
              {t('account.transfer.noOldPhone')}
            </ThemedText>
          </Pressable>

          <PrimaryButton label={t('common.cancel')} onPress={() => router.back()} />
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
    gap: Spacing.cardListGap,
  },
  qrFrame: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    width: QR_SIZE + 40,
    height: QR_SIZE + 40,
    borderRadius: Radius.panel,
    borderWidth: 1,
  },
  qrPlate: {
    padding: Space.s400,
    borderRadius: Radius.notice,
    backgroundColor: Colors.dark.accentBright,
  },
  status: {
    textAlign: 'center',
  },
  noOtherPhone: {
    alignSelf: 'center',
    paddingVertical: Space.s300,
  },
  spacer: {
    flex: 1,
  },
});
