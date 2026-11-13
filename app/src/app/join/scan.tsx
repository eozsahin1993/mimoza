import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { showAlert } from '@/core/services/alerts';
import { inviteCodeFromLink } from '@/features/invite/services/invite-link';
import { savePendingInviteCode } from '@/features/invite/services/pending-invite';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { QrScanner } from '@/ui/components/qr-scanner';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedView } from '@/ui/theme/themed-view';
import { Spacing } from '@/ui/theme/tokens';

/**
 * Scans an invite's QR code in the app, rather than through the system
 * camera and back in by link.
 *
 * Hands the code over the same way join/[code] does: parks it and returns
 * to the circle list, which opens the join sheet over itself on focus.
 * Back to the list rather than router.back(), since Settings opens this too
 * and the sheet only lives on the list.
 */
export default function JoinScanScreen() {
  const { t } = useTranslation();
  const [rearm, setRearm] = useState(0);

  async function handleScanned(data: string) {
    const code = inviteCodeFromLink(data);
    if (!code) {
      showAlert(t('invite.scan.notInvite'), undefined, [
        { text: t('common.cancel'), style: 'cancel', onPress: router.back },
        { text: t('invite.scan.tryAgain'), onPress: () => setRearm((n) => n + 1) },
      ]);
      return;
    }
    await savePendingInviteCode(code);
    router.dismissTo('/circle');
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={styles.headerInset}>
          <ScreenHeader title={t('invite.scan.header')} />
        </View>

        <QrScanner
          rearm={rearm}
          onScanned={(data) => {
            handleScanned(data).catch((err) => console.error('Failed to open a scanned invite', err));
          }}
          instructions={t('invite.scan.instructions')}
          permissionBody={t('account.scanDevice.cameraNeeded')}
          deniedBody={t('account.scanDevice.cameraOff')}
          allowLabel={t('account.scanDevice.allowCamera')}
          openSettingsLabel={t('account.scanDevice.openSettings')}
        />
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
    paddingHorizontal: Spacing.screenPadding,
  },
});
