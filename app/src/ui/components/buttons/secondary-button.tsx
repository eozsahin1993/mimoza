import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { ThemedText } from '@/ui/theme/themed-text';
import { ButtonHeight, Radius, Space } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

export type SecondaryButtonProps = PressableProps & {
  label: string;
};

export function SecondaryButton({ label, style, ...rest }: SecondaryButtonProps) {
  const theme = useTheme();
  const tints = useTints();

  return (
    <Pressable style={style} {...rest}>
      {({ pressed }) => (
        <View
          style={[
            styles.button,
            { borderColor: pressed ? theme.accent : tints.secondaryButtonBorder },
          ]}>
          <ThemedText type="labelLarge" numberOfLines={1}>
            {label}
          </ThemedText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: ButtonHeight.primary,
    paddingVertical: Space.s300,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Space.s600,
  },
});
