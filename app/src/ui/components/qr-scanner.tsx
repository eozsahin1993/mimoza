import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useEffect, useRef } from 'react';
import { Linking, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon } from '@/ui/components/icon';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Colors, Icons, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme } from '@/ui/theme/hooks/use-theme';

export type QrScannerProps = {
  onScanned: (data: string) => void;
  style?: StyleProp<ViewStyle>;
  /** Caption under the viewfinder — what the code being scanned actually is. */
  instructions?: string;
  permissionBody?: string;
  allowLabel?: string;
  deniedBody?: string;
  openSettingsLabel?: string;
  /**
   * Bump to accept another scan. A caller that asks the reader to
   * confirm what was scanned needs this: declining should cost one tap,
   * not a trip back out of the screen, and the camera is still running.
   */
  rearm?: number;
};

const FRAME_SIZE = 240;

/**
 * A full-screen (or embeddable, via `style`) QR scanner: asks for camera
 * permission, points at Settings once it's been denied outright, and calls
 * `onScanned` once per mount — the camera keeps running, but further reads
 * are dropped until this remounts or `rearm` changes. Not tied to any one
 * feature, so account recovery and invite-joining can both point a camera
 * at a code through this component with their own copy.
 */
export function QrScanner({
  onScanned,
  style,
  instructions,
  permissionBody = 'Point your camera at a QR code to scan it.',
  allowLabel = 'Allow camera',
  deniedBody = 'Camera access is off. Turn it on in Settings to scan.',
  openSettingsLabel = 'Open Settings',
  rearm = 0,
}: QrScannerProps) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  useEffect(() => {
    scannedRef.current = false;
  }, [rearm]);

  function handleBarcodeScanned(result: BarcodeScanningResult) {
    if (scannedRef.current) return;
    scannedRef.current = true;
    onScanned(result.data);
  }

  if (!permission || !permission.granted) {
    const deniedForGood = permission !== null && !permission.canAskAgain;
    return (
      <ThemedView style={[styles.permission, style]}>
        <Icon icon={deniedForGood ? Icons.cameraOff : Icons.camera} size={40} color={theme.muted} />
        <ThemedText type="titleMedium" themeColor="muted" style={styles.permissionText}>
          {deniedForGood ? deniedBody : permissionBody}
        </ThemedText>
        <PrimaryButton
          label={deniedForGood ? openSettingsLabel : allowLabel}
          onPress={deniedForGood ? () => Linking.openSettings() : requestPermission}
          style={styles.permissionButton}
        />
      </ThemedView>
    );
  }

  return (
    <View style={[styles.container, style]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarcodeScanned}
      />
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.dim} />
        <View style={styles.middleRow}>
          <View style={styles.dim} />
          <View style={styles.frame} />
          <View style={styles.dim} />
        </View>
        <View style={[styles.dim, styles.bottomDim]}>
          {instructions ? (
            // Fixed light color rather than ThemedText's scheme-matched default —
            // this sits on the camera feed, not the page, same reasoning as the
            // wordmark over the welcome photo.
            <ThemedText type="bodyMedium" style={[styles.instructions, { color: Colors.dark.text }]}>
              {instructions}
            </ThemedText>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.dark.background,
  },
  permission: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.screenPadding,
    gap: Spacing.cardListGap,
  },
  permissionText: {
    textAlign: 'center',
  },
  permissionButton: {
    alignSelf: 'stretch',
  },
  dim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  middleRow: {
    flexDirection: 'row',
    height: FRAME_SIZE,
  },
  frame: {
    width: FRAME_SIZE,
    height: FRAME_SIZE,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.9)',
    borderRadius: Radius.panel,
  },
  bottomDim: {
    alignItems: 'center',
    paddingTop: Space.s600,
  },
  instructions: {
    textAlign: 'center',
    paddingHorizontal: Spacing.screenPadding,
  },
});
