import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { ButtonHeight, Radius, Space } from '@/ui/theme/tokens';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { useTheme } from '@/ui/theme/hooks/use-theme';

export type PrimaryButtonProps = PressableProps & {
  label: string;
  /** 'destructive' fills the button in the danger color instead of the accent gradient — for a confirm that can't be undone. */
  tone?: 'default' | 'destructive';
};

export function PrimaryButton({ label, style, disabled, tone = 'default', ...rest }: PrimaryButtonProps) {
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
        ) : tone === 'destructive' ? (
          <View style={[styles.button, { backgroundColor: theme.danger }, pressed && styles.pressed]}>
            <ThemedText type="labelLarge" style={styles.destructiveLabel} numberOfLines={1}>
              {label}
            </ThemedText>
          </View>
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
  destructiveLabel: {
    color: '#FFFFFF',
  },
});
