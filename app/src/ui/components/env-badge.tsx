import Constants from 'expo-constants';
import { StyleSheet, Text, View } from 'react-native';
import { Space } from '@/ui/theme/tokens';

/** Set by app.config.js; absent in tests and in a bare `expo start`. */
const APP_ENV = (Constants.expoConfig?.extra as { appEnv?: string } | undefined)?.appEnv;

/**
 * Names the environment unless it's production — a staging build is
 * otherwise indistinguishable once it's open, and bugs get filed against
 * data that was never real.
 *
 * A ribbon across the bottom-left corner: always in frame, including in
 * screenshots, while leaving the middle of every screen alone. The
 * container clips it to the corner, so the bar can overhang both edges
 * and still look cut to fit.
 */
export function EnvBadge() {
  // Machine-local escape hatch for a clean screenshot without lying to
  // the build about which environment it actually is — see .env.example.
  if (process.env.EXPO_PUBLIC_HIDE_ENV_BADGE === 'true') return null;
  if (!APP_ENV || APP_ENV === 'production') return null;

  return (
    <View style={styles.corner} pointerEvents="none">
      <View style={styles.ribbon}>
        <Text style={styles.label}>{APP_ENV.toUpperCase()}</Text>
      </View>
    </View>
  );
}

const SIZE = 104;

const styles = StyleSheet.create({
  corner: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: SIZE,
    height: SIZE,
    overflow: 'hidden',
  },
  ribbon: {
    position: 'absolute',
    // Overhangs both edges before rotating, so the ends are clipped by the
    // corner rather than floating inside it.
    left: -SIZE / 2,
    bottom: SIZE / 5,
    width: SIZE * 1.5,
    paddingVertical: Space.s100,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    transform: [{ rotate: '45deg' }],
  },
  label: {
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 1.2,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.9)',
  },
});
