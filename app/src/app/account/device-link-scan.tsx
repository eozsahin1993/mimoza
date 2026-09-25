import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';

import { DeviceLinkAnsweredError, DeviceLinkGoneError } from '@/core/services/relay-errors';
import { completeDeviceLink, parseDeviceLinkPayload } from '@/features/account/usecases/device-link';
import { getProfile, listCircles } from '@/data/db';
import { LoadingModal } from '@/ui/components/loading-modal';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { QrScanner } from '@/ui/components/qr-scanner';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedView } from '@/ui/theme/themed-view';
import { Spacing } from '@/ui/theme/tokens';
import type { DeviceLinkPayload } from '@/features/account/usecases/device-link';

/**
 * The answering end of a device link: this phone already has the keys,
 * and device-link.tsx is the one waiting for them.
 *
 * Scanning is the easy half; the confirmation is the point. Nothing
 * leaves this phone until it is answered, because what leaves is the key
 * to every circle and there is no taking it back.
 */
export default function DeviceLinkScanScreen() {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  // The scanner reads once and then holds; declining the confirmation
  // re-arms it so a mis-scan costs one tap rather than the whole trip
  // back through Account.
  const [rearm, setRearm] = useState(0);

  async function send(payload: DeviceLinkPayload) {
    const profile = await getProfile();
    if (!profile) return;
    setSending(true);
    try {
      await completeDeviceLink(profile.accountId, payload);
      Alert.alert(t('account.scanDevice.sent'), undefined, [{ text: t('account.scanDevice.back'), onPress: router.back }]);
    } catch (err) {
      console.error('Failed to send the account keys to the scanned device', err);
      const gone = err instanceof DeviceLinkGoneError || err instanceof DeviceLinkAnsweredError;
      Alert.alert(
        t('account.scanDevice.addFailed'),
        gone ? t('account.scanDevice.expiredCode') : t('account.transfer.somethingWrong'),
        [{ text: t('account.scanDevice.back'), onPress: router.back }]
      );
    } finally {
      setSending(false);
    }
  }

  async function handleScanned(data: string) {
    let payload: DeviceLinkPayload;
    try {
      payload = parseDeviceLinkPayload(data);
    } catch {
      Alert.alert(t('account.scanDevice.unreadableCode'), t('account.scanDevice.invalidCode'), [
        { text: t('account.scanDevice.back'), onPress: router.back },
      ]);
      return;
    }

    const count = (await listCircles()).length;
    Alert.alert(t('account.scanDevice.confirmTitleUnnamed'), t('account.scanDevice.confirmMessage', { count }), [
      { text: t('common.cancel'), style: 'cancel', onPress: () => setRearm((n) => n + 1) },
      { text: t('account.scanDevice.addDevice'), onPress: () => void send(payload) },
    ]);
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={styles.headerInset}>
          <ScreenHeader title={t('account.scanDevice.header')} />
        </View>

        <QrScanner
          rearm={rearm}
          onScanned={(data) => void handleScanned(data)}
          instructions={t('account.scanDevice.instructions')}
          permissionBody={t('account.scanDevice.cameraNeeded')}
          deniedBody={t('account.scanDevice.cameraOff')}
          allowLabel={t('account.scanDevice.allowCamera')}
          openSettingsLabel={t('account.scanDevice.openSettings')}
        />
      </ThemedSafeAreaView>

      <LoadingModal visible={sending} label={t('account.transfer.waiting')} />
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
    paddingHorizontal: Spacing.screenPadding,
  },
});
