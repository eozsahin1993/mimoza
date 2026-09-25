import { Image } from 'expo-image';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { Icon, type IconGlyph } from '@/ui/components/icon';
import { PhotoPlaceholder } from '@/ui/components/photo-placeholder';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

/**
 * What sits at the end of a row, by kind rather than by markup — the same
 * idea as Android's `Preference` subclasses. A screen names the kind it
 * wants; how each one is drawn, sized and spaced is settled once here.
 */
export type SettingsControl =
  /** Goes somewhere: a chevron. */
  | { kind: 'navigate' }
  /** Flips something: a switch, which handles the tap itself. */
  | { kind: 'switch'; value: boolean; onValueChange: (value: boolean) => void }
  /** Shows what it's currently set to, e.g. "Admins only". */
  | { kind: 'value'; text: string }
  /** A picture, with the hatch placeholder when there isn't one yet. */
  | { kind: 'image'; uri?: string | null };

export type SettingsRowProps = {
  label: string;
  /** What the setting does, or what changes when it does. */
  description?: string;
  /** Leading glyph — see `Icons`, which names these by what they mean. */
  icon?: IconGlyph;
  control?: SettingsControl;
  /** Danger tone on the label, for a row that takes something away. */
  destructive?: boolean;
  onPress?: () => void;
  disabled?: boolean;
};

function SettingsAccessory({ control, disabled }: { control: SettingsControl; disabled?: boolean }) {
  const theme = useTheme();
  const tints = useTints();

  switch (control.kind) {
    case 'navigate':
      return <Icon icon={Icons.disclosure} size={20} color={theme.muted} />;
    case 'switch':
      return (
        <Switch
          value={control.value}
          onValueChange={control.onValueChange}
          disabled={disabled}
          trackColor={{ false: tints.switchTrack, true: theme.accent }}
          thumbColor={theme.text}
        />
      );
    case 'value':
      return (
        <ThemedText type="labelSmall" themeColor="muted">
          {control.text}
        </ThemedText>
      );
    case 'image':
      // Bordered either way: the placeholder's fill is `surface`, the same
      // as the card it sits in, so without an edge an unset image reads as
      // nothing at all rather than as an empty slot.
      return control.uri ? (
        <Image
          source={{ uri: control.uri }}
          style={[styles.image, { borderColor: tints.secondaryButtonBorder, backgroundColor: theme.background }]}
          contentFit="cover"
        />
      ) : (
        <PhotoPlaceholder
          style={[styles.image, { borderColor: tints.secondaryButtonBorder, backgroundColor: theme.background }]}
        />
      );
  }
}

/**
 * A settings row: what it's called, what it does, and the control for it.
 *
 * Shared because every such row is the same shape and only the control
 * differs — three near-identical blocks of JSX drift apart the moment one
 * of them is touched.
 */
export function SettingsRow({ label, description, icon, control, destructive, onPress, disabled }: SettingsRowProps) {
  const theme = useTheme();

  // A switch is its own hit target; making the row tappable too would
  // give the same setting two ways to change that can disagree.
  const pressable = Boolean(onPress) && control?.kind !== 'switch';

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && pressable ? styles.pressed : null]}
      disabled={!pressable || disabled}
      onPress={onPress}>
      {icon ? (
        <View style={styles.icon}>
          <Icon icon={icon} size={20} color={destructive ? theme.danger : theme.secondary} />
        </View>
      ) : null}

      <View style={styles.text}>
        <ThemedText type="titleSmall" themeColor={destructive ? 'danger' : 'text'}>
          {label}
        </ThemedText>
        {description ? (
          <ThemedText type="labelSmall" themeColor="muted">
            {description}
          </ThemedText>
        ) : null}
      </View>

      {control ? <SettingsAccessory control={control} disabled={disabled} /> : null}
    </Pressable>
  );
}

export type SettingsGroup = {
  /** The section title above the rows. */
  title: string;
  /** Danger tone on that title, for a group of things you can't undo. */
  destructive?: boolean;
  /**
   * Falsy entries are dropped, so a row can be gated inline
   * (`admin && { ... }`) without the caller assembling arrays first.
   */
  rows: (SettingsRowProps | false | null | undefined)[];
  /** A quiet line under the group — the caveat that applies to all of it, not to one row. */
  footnote?: string;
};

/**
 * Settings as data rather than JSX: a screen declares its groups, and
 * adding a setting is one object in that list — no new markup, no new
 * spacing decision, and nothing to keep in sync with the group beside it.
 *
 * The title-over-a-bordered-card shape is the account screen's, kept as
 * the single form so every settings surface in the app reads the same.
 * A group with no surviving rows renders nothing, so gating a whole
 * section on `admin` needs no wrapper.
 */
export function SettingsGroups({ groups }: { groups: SettingsGroup[] }) {
  const tints = useTints();

  return (
    <>
      {groups.map((group) => {
        const rows = group.rows.filter((row): row is SettingsRowProps => Boolean(row));
        if (rows.length === 0) return null;

        return (
          <View key={group.title} style={styles.section}>
            <ThemedText type="labelMedium" themeColor={group.destructive ? 'danger' : undefined}>
              {group.title}
            </ThemedText>

            <ThemedView type="surface" style={[styles.card, { borderColor: tints.chipIdleBorder }]}>
              {rows.map((row, index) => (
                <View
                  key={row.label}
                  style={index === rows.length - 1 ? undefined : [styles.divided, { borderBottomColor: tints.chipIdleBorder }]}>
                  <SettingsRow {...row} />
                </View>
              ))}
            </ThemedView>

            {group.footnote ? (
              <ThemedText type="labelSmall" themeColor="faint" style={styles.footnote}>
                {group.footnote}
              </ThemedText>
            ) : null}
          </View>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: Spacing.cardListGap,
    gap: Space.s300,
  },
  card: {
    borderWidth: 1,
    borderRadius: Radius.notice,
    paddingHorizontal: Spacing.screenPadding,
  },
  divided: {
    borderBottomWidth: 1,
  },
  footnote: {
    paddingHorizontal: Space.s100,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
    paddingVertical: Space.s400,
  },
  pressed: {
    opacity: 0.6,
  },
  // Fixed width so labels line up down the group whatever each glyph measures.
  icon: {
    width: 24,
    alignItems: 'center',
  },
  text: {
    flex: 1,
    gap: Space.s100,
  },
  image: {
    width: 64,
    height: 44,
    borderRadius: Radius.notice,
    borderWidth: 1,
  },
});
