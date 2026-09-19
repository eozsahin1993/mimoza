import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { ButtonHeight, Radius, Space } from '@/ui/theme/tokens';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { useTheme } from '@/ui/theme/hooks/use-theme';

export type PrimaryButtonProps = PressableProps & {
  label: string;
};

export function PrimaryButton({ label, style, disabled, ...rest }: PrimaryButtonProps) {
  const theme = useTheme();

  return (
    <Pressable style={style} disabled={disabled} {...rest}>
      {({ pressed }) =>
        disabled ? (
          <ThemedView style={styles.button} type="surface">
            <ThemedText type="labelLarge" themeColor="faintest" numberOfLines={1}>
              {label}
            </ThemedText>
          </ThemedView>
        ) : (
          <LinearGradient
            colors={[theme.accent, theme.accentBright]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.button, pressed && styles.pressed]}>
            <ThemedText type="labelLarge" themeColor="accentLabel" numberOfLines={1}>
              {label}
            </ThemedText>
          </LinearGradient>
        )
      }
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: ButtonHeight.primary,
    paddingVertical: Space.s300,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Space.s600,
  },
  pressed: {
    opacity: 0.85,
  },
});
