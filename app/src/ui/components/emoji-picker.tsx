import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { REACTION_EMOJI } from '@/core/crypto/reaction-tags';

import { Icon } from '@/ui/components/icon';
import { Icons, Radius, Space } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

export type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  /**
   * Dismisses without reacting. Not optional in practice: the panel opens
   * inline over a card whose caption and photo both navigate away, so
   * "tap outside to close" would take you to the post instead. The only
   * other way out is the chip that opened it, which nothing signposts.
   */
  onClose?: () => void;
};

/**
 * One full-width panel of evenly-divided slots, rather than a row of
 * separate pills — pills read as a scatter of unrelated buttons that
 * happened to land near each other, when this is a single choice among a
 * fixed set. Every slot is the same width and shares one outline, so the
 * row scans in one pass and the tap targets are unambiguous.
 *
 * One row, always. Wrapping to a grid made the panel taller than the
 * caption above it, and a choice this small shouldn't need two lines.
 */
export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();

  return (
    <View style={[styles.panel, { borderColor: tints.chipIdleBorder, backgroundColor: tints.chipIdleBg }]}>
      {REACTION_EMOJI.map((emoji) => (
        <Pressable key={emoji} style={styles.slot} onPress={() => onSelect(emoji)}>
          <Text style={styles.emoji}>{emoji}</Text>
        </Pressable>
      ))}

      {onClose ? (
        <Pressable style={styles.slot} onPress={onClose} accessibilityLabel={t('ui.close')}>
          <Icon icon={Icons.close} size={17} color={theme.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.panel,
    borderWidth: 1,
    paddingHorizontal: Space.s100,
  },
  /**
   * `flex: 1` on every slot is what divides the panel evenly however many
   * reactions the set holds — nothing here is sized to the current eight.
   * Adding many more would squeeze the slots under a comfortable tap
   * target, which is the point at which this needs to become a sheet
   * rather than an inline row.
   */
  slot: {
    flex: 1,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 20,
  },
});
