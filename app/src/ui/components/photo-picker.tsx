import { Image } from 'expo-image';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/ui/components/icon';
import { PhotoPlaceholder } from '@/ui/components/photo-placeholder';
import { ThemedText } from '@/ui/theme/themed-text';
import { Icons, Radius, Space } from '@/ui/theme/tokens';
import { useTheme } from '@/ui/theme/hooks/use-theme';

export type PhotoPickerProps = {
  /** The picked photo's local URI, if one's been chosen — the hatch placeholder otherwise. */
  uri?: string;
  aspectRatio: number;
  /** What to say under the centered icon before anything's picked — "Tap to choose a photo", "Tap to pick from your library". */
  label: string;
  onPress: () => void;
};

/**
 * Tap-to-pick photo slot: the chosen image once there is one, otherwise a
 * hatch placeholder with a centered add-photo icon and a caption. Shared
 * by every screen that picks one photo — a circle's cover, a post's own
 * photo — so the affordance looks and behaves the same everywhere.
 */
export function PhotoPicker({ uri, aspectRatio, label, onPress }: PhotoPickerProps) {
  const theme = useTheme();

  return (
    <Pressable onPress={onPress}>
      {uri ? (
        <Image source={{ uri }} style={[styles.photo, { aspectRatio }]} contentFit="cover" />
      ) : (
        <PhotoPlaceholder style={[styles.photo, { aspectRatio }]}>
          <View style={styles.prompt} pointerEvents="none">
            <Icon icon={Icons.addPhoto} size={40} color={theme.muted} />
            <ThemedText type="labelSmall" themeColor="muted">
              {label}
            </ThemedText>
          </View>
        </PhotoPlaceholder>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  photo: {
    borderRadius: Radius.panel,
  },
  // Icon and caption centred together: a cover's slot is a short strip,
  // too low for a caption pinned to the bottom to clear the icon.
  prompt: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.s200,
  },
});
