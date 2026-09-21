import { useEffect, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View } from 'react-native';

import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTints } from '@/ui/theme/hooks/use-theme';

export type DialogProps = {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** Also what tapping outside or the Android back button does. */
  onCancel: () => void;
};

/**
 * A centered two-button dialog in the app's own style — for a decision
 * that deserves the middle of the screen, where a sheet would read as a
 * side action. A styled stand-in for `Alert.alert`, which can't be themed.
 *
 * Same fade mechanics as `LoadingModal`: mounted but not visible, so the
 * closing fade has something left to animate.
 */
export function Dialog({ visible, title, message, confirmLabel, cancelLabel, onConfirm, onCancel }: DialogProps) {
  const tints = useTints();
  const [mounted, setMounted] = useState(visible);
  const [progress] = useState(() => new Animated.Value(visible ? 1 : 0));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (visible) setMounted(true);

    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 240 : 200,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, progress]);

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onCancel}>
      <Animated.View style={[styles.backdrop, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        {/* `raised`, as for anything floating over the page (see the
            tokens' note): `surface` all but vanishes into a dark page. */}
        <ThemedView type="raised" style={[styles.card, { borderColor: tints.raisedBorder }]}>
          <ThemedText type="titleLarge">{title}</ThemedText>
          <ThemedText type="bodyMedium" themeColor="muted">
            {message}
          </ThemedText>
          <View style={styles.actions}>
            <SecondaryButton label={cancelLabel} style={styles.action} onPress={onCancel} />
            <PrimaryButton label={confirmLabel} style={styles.action} onPress={onConfirm} />
          </View>
        </ThemedView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.screenPadding,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  card: {
    borderRadius: Radius.panel,
    borderWidth: 1,
    padding: Space.s600,
    gap: Space.s300,
  },
  actions: {
    flexDirection: 'row',
    gap: Space.s300,
    marginTop: Space.s200,
  },
  action: {
    flex: 1,
  },
});
