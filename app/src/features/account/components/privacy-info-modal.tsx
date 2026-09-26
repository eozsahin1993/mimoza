import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Dimensions, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { Icon } from '@/ui/components/icon';
import { Bloom } from '@/ui/components/wordmark';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme } from '@/ui/theme/hooks/use-theme';
import { upperCase } from '@/core/i18n/text';
import { useLanguage } from '@/core/i18n/use-language';

export type PrivacyInfoModalProps = {
  visible: boolean;
  onClose: () => void;
};

// The copy states the claim `docs/DESIGN.md` makes and no more: content
// is end-to-end encrypted, membership is not. Keep it in step with that
// file and `RELAY_DESIGN.md` ("What is encrypted"), not with what the
// design hopes to do next.
const POINTS = ['content', 'account', 'sharing'] as const;

const BLOOM_SIZE = 14;
/**
 * The domain the launch checklist reserves for the policy. Nothing is
 * deployed there yet, so this leads nowhere until the site is — see
 * `docs/LAUNCH_CHECKLIST.md`, "Store listings".
 */
const PRIVACY_POLICY_URL = 'https://joinmimoza.com/privacy';
/** The circle list's section titles, at the same size: `code` is sized for an invite code standing on its own. */
const LABEL_SIZE = 12;
const LABEL_LINE_HEIGHT = LABEL_SIZE * 1.3;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SLIDE_DISTANCE = Dimensions.get('window').height;

export function PrivacyInfoModal({ visible, onClose }: PrivacyInfoModalProps) {
  const { t } = useTranslation();
  const language = useLanguage();
  const theme = useTheme();
  // Modal unmounts the instant `visible` goes false, which would cut off
  // any exit animation — so mounting is tracked separately, and only
  // dropped once the closing animation actually finishes.
  const [mounted, setMounted] = useState(visible);
  const [progress] = useState(() => new Animated.Value(visible ? 1 : 0));

  useEffect(() => {
    // Opening must show the modal immediately, before the animation even
    // starts — closing can't do the equivalent (`setMounted(false)`) here,
    // it has to wait for the animation's own completion callback below, so
    // the two directions aren't symmetric enough for the render-phase
    // "adjust state from a prop" pattern to cleanly cover both.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (visible) setMounted(true);

    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 280 : 220,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, progress]);

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <AnimatedPressable style={[styles.backdrop, { opacity: progress }]} onPress={onClose} />

      <Animated.View
        style={[
          styles.sheet,
          {
            transform: [
              { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [SLIDE_DISTANCE, 0] }) },
            ],
          },
        ]}>
        <ThemedView type="surface" style={styles.sheetInner}>
          <ThemedSafeAreaView edges={['bottom']} style={styles.column}>
            <View style={[styles.grabber, { backgroundColor: theme.faintest }]} />

            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
              <ThemedText type="titleLarge" style={styles.title}>
                {t('account.privacy.title')}
              </ThemedText>

              {POINTS.map((point) => (
                <View key={point} style={styles.point}>
                  <Bloom size={BLOOM_SIZE} style={styles.pointBloom} />
                  <View style={styles.pointText}>
                    <ThemedText type="code" themeColor="muted" style={styles.pointLabel}>
                      {upperCase(t(`account.privacy.points.${point}.label`), language)}
                    </ThemedText>
                    <ThemedText type="bodyMedium" themeColor="secondary">
                      {t(`account.privacy.points.${point}.body`)}
                    </ThemedText>
                  </View>
                </View>
              ))}

              <Pressable
                style={styles.policyLink}
                hitSlop={8}
                accessibilityRole="link"
                onPress={() => {
                  Linking.openURL(PRIVACY_POLICY_URL).catch((err) => console.error('Failed to open the privacy policy', err));
                }}>
                <ThemedText type="labelLarge" themeColor="accentBright">
                  {t('account.privacy.readPolicy')}
                </ThemedText>
                <Icon icon={Icons.external} size={16} color={theme.accentBright} />
              </Pressable>
            </ScrollView>

            <View style={styles.footer}>
              <SecondaryButton label={t('account.privacy.close')} onPress={onClose} />
            </View>
          </ThemedSafeAreaView>
        </ThemedView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '85%',
  },
  // `flexShrink: 1` from here down to the scroll view. Yoga's default is
  // 0, so without it a body taller than `maxHeight` doesn't shrink and
  // scroll, it overflows, and `overflow: 'hidden'` clips the Close button
  // off the bottom.
  sheetInner: {
    flexShrink: 1,
    borderTopLeftRadius: Radius.bottomSheet,
    borderTopRightRadius: Radius.bottomSheet,
    overflow: 'hidden',
  },
  column: {
    flexShrink: 1,
  },
  scroll: {
    flexShrink: 1,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginTop: Space.s300,
    marginBottom: Space.s200,
  },
  content: {
    paddingHorizontal: Spacing.screenPadding,
    gap: Spacing.cardListGap,
  },
  // Wider than the gap between sections, so the title reads as the
  // sheet's heading rather than as one more label in the list.
  title: {
    marginTop: Space.s200,
    marginBottom: Space.s300,
  },
  point: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.s300,
  },
  // Against the first line, so a bullet that wraps keeps its marker at
  // the top rather than drifting to the middle. Nudged below the line
  // box's centre: the small mono glyphs sit low in it, and a bloom
  // centred on the box reads as floating above the label.
  pointBloom: {
    marginTop: (LABEL_LINE_HEIGHT - BLOOM_SIZE) / 2 + Space.s100,
  },
  pointText: {
    flex: 1,
    gap: Space.s100,
  },
  pointLabel: {
    fontSize: LABEL_SIZE,
    lineHeight: LABEL_LINE_HEIGHT,
    letterSpacing: LABEL_SIZE * 0.13,
  },
  // Indented to the text column, so it reads as the points' footnote
  // rather than a fourth bullet.
  policyLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s100,
    marginLeft: BLOOM_SIZE + Space.s300,
  },
  footer: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Space.s900,
    paddingBottom: Spacing.cardListGap,
  },
});
