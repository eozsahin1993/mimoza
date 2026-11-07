import { useEffect, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon, type IconGlyph } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, Radius, Space, Spacing, type ThemeColor } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import type { MessageController } from '@/core/hooks/use-messages';
import type { Message } from '@/core/services/messages';

/** How each tone is drawn, given this scheme's tints. The glyph carries the state, never the fill. */
function tonesFor(tints: ReturnType<typeof useTints>) {
  return {
    done: { icon: Icons.done, color: 'accentBright', border: tints.raisedAccentBorder },
    neutral: { icon: Icons.info, color: 'muted', border: tints.raisedBorder },
    error: { icon: Icons.error, color: 'danger', border: tints.raisedDangerBorder },
  } as const satisfies Record<Message['tone'], { icon: IconGlyph; color: ThemeColor; border: string }>;
}

const LIFT = 12;
const FADE_MS = 180;

/**
 * All three values are driven from JS, none natively. The drag feeds the
 * transform through `setValue`, and a node the native driver has taken
 * over won't accept one — the first animation to claim a node with
 * `useNativeDriver: true` owns it for the life of the value, and every
 * later JS-driven animation on it throws. Driving two of the three
 * natively worked but left the rule "don't make this one native" resting
 * on nothing; one driver can't be got wrong.
 */
const USE_NATIVE_DRIVER = false;

/** Far enough down that a scroll flick past the bar can't be read as one. */
const SWIPE_TO_DISMISS = 40;

export type SnackbarProps = Omit<MessageController, 'settle'> & {
  /** Called once it has finished leaving — see `useMessages`, which waits for this before showing the next. */
  onHidden: () => void;
};

/**
 * One message, drawn. Owns nothing but its own motion: which message
 * this is, how long it stands and what follows it are `useMessages`'s,
 * so the timing rules can be read and changed without rendering
 * anything.
 *
 * Not a `Modal`, unlike the app's sheets: this interrupts nothing and
 * takes no decision, so the screen behind stays live and tappable (see
 * `pointerEvents` below). Positioned by whoever mounts it — at the router
 * root, so a message outlives the screen that caused it.
 */
export function Snackbar({ message, visible, dismiss, onHidden }: SnackbarProps) {
  const theme = useTheme();
  const tints = useTints();
  const [opacity] = useState(() => new Animated.Value(0));
  const [lift] = useState(() => new Animated.Value(0));
  const [drag] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (visible) {
      lift.setValue(0);
      drag.setValue(0);
    }

    Animated.parallel([
      Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: FADE_MS, useNativeDriver: USE_NATIVE_DRIVER }),
      // Only on the way in. It leaves on a fade alone, so a bar that has
      // said its piece doesn't draw the eye back down on its way out.
      ...(visible ? [Animated.timing(lift, { toValue: 1, duration: FADE_MS, useNativeDriver: USE_NATIVE_DRIVER })] : []),
    ]).start(({ finished }) => {
      if (finished && !visible) onHidden();
    });
  }, [visible, opacity, lift, drag, onHidden]);

  // Down only, and never up: this sits at the bottom, so there's nowhere
  // above it to go.
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 4,
      onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > SWIPE_TO_DISMISS) {
          dismiss();
        } else {
          Animated.timing(drag, { toValue: 0, duration: FADE_MS, useNativeDriver: USE_NATIVE_DRIVER }).start();
        }
      },
    }),
  );

  if (!message) return null;

  const tone = tonesFor(tints)[message.tone];

  return (
    // box-none, not none: the bar itself takes taps while the screen
    // underneath keeps every one that lands outside it. Native
    // `SafeAreaView`, not `useSafeAreaInsets`, whose value can arrive a
    // render late and show as a visible snap into position.
    <SafeAreaView
      edges={['bottom']}
      style={[styles.host, { paddingBottom: Spacing.pinnedButtonFromBottom }]}
      pointerEvents="box-none">
      <Animated.View
        {...pan.panHandlers}
        style={{
          opacity,
          transform: [
            { translateY: Animated.add(lift.interpolate({ inputRange: [0, 1], outputRange: [LIFT, 0] }), drag) },
          ],
        }}>
        {/* `raised` rather than `surface`, and lifted off the page: a
            settings card's fill and edge would make this read as one more
            box on the screen. The shadow is what carries it over a
            photograph, where the fill alone would blend. */}
        <ThemedView type="raised" style={[styles.bar, { borderColor: tone.border }]}>
          <Icon icon={message.icon ?? tone.icon} size={18} color={theme[tone.color]} />

          <ThemedText type="bodyMedium" themeColor="body" numberOfLines={2} style={styles.text}>
            {message.text}
          </ThemedText>

          {message.action ? (
            <Pressable
              hitSlop={10}
              onPress={() => {
                dismiss();
                message.action?.onPress();
              }}>
              <ThemedText type="labelLarge" themeColor="accentBright">
                {message.action.label}
              </ThemedText>
            </Pressable>
          ) : null}
        </ThemedView>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.screenPadding,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
    paddingHorizontal: Space.s400,
    paddingVertical: Space.s300,
    borderRadius: Radius.input,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 10,
  },
  text: {
    flex: 1,
  },
});
