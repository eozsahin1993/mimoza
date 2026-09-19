import { AntDesign } from '@expo/vector-icons';
import { Pressable, View, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/ui/theme/themed-text';
import { ButtonHeight, Radius, Space } from '@/ui/theme/tokens';
import { useAppSettings } from '@/ui/theme/hooks/use-app-settings';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

/** Google's standard four-color "G" mark — required as-is, not recolored to match app theme. */
function GoogleLogo() {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.8741 2.6836-6.615z"
      />
      <Path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1818l-2.9087-2.2581c-.8059.54-1.8368.8591-3.0477.8591-2.344 0-4.3282-1.5831-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <Path
        fill="#FBBC05"
        d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 000 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
      />
      <Path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </Svg>
  );
}

type SocialButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  label: string;
  icon: ReactNode;
  contentColor: string;
  /** The pill's own background/border — one provider fills it, the other outlines it, so this is left fully open rather than assuming a shape. */
  fillStyle: StyleProp<ViewStyle>;
};

/** The shape every provider's button renders into — see AppleSignInButton/GoogleSignInButton for what actually goes in it. */
function SocialButton({ label, icon, contentColor, fillStyle, disabled, ...rest }: SocialButtonProps) {
  return (
    <Pressable disabled={disabled} {...rest}>
      {({ pressed }) => (
        <View style={[styles.button, fillStyle, pressed && styles.pressed, disabled && styles.disabled]}>
          {/*
            The icon is wrapped: this render function re-runs on every
            press (`pressed`), and an unwrapped SvgView in a slot that
            re-renders is what Fabric tries to move rather than recreate —
            see photo-placeholder.tsx.
          */}
          <View style={styles.icon}>{icon}</View>
          {/* flexShrink so a long label truncates against the icon rather than
              pushing past the button's edge. */}
          <ThemedText
            type="labelLarge"
            style={{ color: contentColor, flexShrink: 1 }}
            numberOfLines={1}>
            {label}
          </ThemedText>
        </View>
      )}
    </Pressable>
  );
}

export type AppleSignInButtonProps = Omit<PressableProps, 'style' | 'children'>;

/**
 * Apple's own guidelines ask for one of its fixed white/black pairs, never
 * a color recolored to match app branding, but do expect the pair to
 * switch with light/dark mode so it keeps contrast against the page — the
 * same reason the native button component takes a light/dark
 * `buttonStyle`. The pale fill read fine against a dark page but nearly
 * vanished into the light one, since it was fixed to the same off-white
 * either way — light mode needs the inverse pair instead.
 */
export function AppleSignInButton(props: AppleSignInButtonProps) {
  const { t } = useTranslation();
  const { scheme } = useAppSettings();
  const fill = scheme === 'dark' ? '#F4EDE2' : '#231A11';
  const content = scheme === 'dark' ? '#000000' : '#F4EDE2';

  return (
    <SocialButton
      {...props}
      label={t('onboarding.continueWithApple')}
      icon={<AntDesign name="apple" size={18} color={content} />}
      contentColor={content}
      fillStyle={{ backgroundColor: fill }}
    />
  );
}

export type GoogleSignInButtonProps = Omit<PressableProps, 'style' | 'children'>;

/**
 * Google's mark is similarly fixed-color, but the pill itself follows the
 * app's usual outlined-button look instead of Google's own filled style,
 * to sit next to the Apple button without one looking like an afterthought.
 */
export function GoogleSignInButton(props: GoogleSignInButtonProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();

  return (
    <SocialButton
      {...props}
      label={t('onboarding.continueWithGoogle')}
      icon={<GoogleLogo />}
      contentColor={theme.text}
      fillStyle={[styles.google, { borderColor: tints.secondaryButtonBorder }]}
    />
  );
}

const styles = StyleSheet.create({
  icon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    minHeight: ButtonHeight.primary,
    paddingVertical: Space.s300,
    borderRadius: Radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.s300,
    paddingHorizontal: Space.s600,
  },
  google: {
    borderWidth: 1,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.5,
  },
});
