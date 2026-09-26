import { useEffect, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View } from 'react-native';

import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTints } from '@/ui/theme/hooks/use-theme';

export type DialogButton = {
  text: string;
  /** 'destructive' fills the button in the danger color. 'cancel' is what tapping outside or the Android back button triggers, on top of closing. */
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
};

export type DialogProps = {
  visible: boolean;
  title: string;
  message?: string;
  /** One button renders full-width; two render side by side, the first as the secondary (left) action. */
  buttons: DialogButton[];
  /** Always fires on close — tapping outside, the Android back button, or either button. */
  onDismiss: () => void;
  /** Called once the closing fade has finished — see `useAlerts`, which waits for this before showing the next one queued. */
  onHidden?: () => void;
};

/**
 * A centered dialog in the app's own style — for a decision that
 * deserves the middle of the screen, where a sheet would read as a side
 * action. A styled stand-in for `Alert.alert`, which can't be themed.
 *
 * Same fade mechanics as `LoadingModal`: mounted but not visible, so the
 * closing fade has something left to animate.
 */
export function Dialog({ visible, title, message, buttons, onDismiss, onHidden }: DialogProps) {
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
      if (finished && !visible) {
        setMounted(false);
        onHidden?.();
      }
    });
  }, [visible, progress, onHidden]);

  if (!mounted) return null;

  const [first, second] = buttons;
  const primary = second ?? first;

  function handleBackdrop() {
    // Matches what the platform's own alert does when there's a way to
    // decline — a bare "OK" alert has no cancel button, so dismissing it
    // this way answers nothing.
    buttons.find((button) => button.style === 'cancel')?.onPress?.();
    onDismiss();
  }

  function press(button: DialogButton) {
    onDismiss();
    button.onPress?.();
  }

  return (
    <Modal transparent visible animationType="none" onRequestClose={handleBackdrop}>
      <Animated.View style={[styles.backdrop, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleBackdrop} />
        {/* `raised`, as for anything floating over the page (see the
            tokens' note): `surface` all but vanishes into a dark page. */}
        <ThemedView type="raised" style={[styles.card, { borderColor: tints.raisedBorder }]}>
          <ThemedText type="titleLarge">{title}</ThemedText>
          {message ? (
            <ThemedText type="bodyMedium" themeColor="muted">
              {message}
            </ThemedText>
          ) : null}
          <View style={styles.actions}>
            {second ? <SecondaryButton label={first.text} style={styles.action} onPress={() => press(first)} /> : null}
            <PrimaryButton
              label={primary.text}
              tone={primary.style === 'destructive' ? 'destructive' : 'default'}
              style={styles.action}
              onPress={() => press(primary)}
            />
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
