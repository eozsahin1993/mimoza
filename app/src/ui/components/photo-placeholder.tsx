import { useTranslation } from 'react-i18next';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { Pressable, StyleSheet, View, type ViewProps } from 'react-native';

import { Icon, type IconGlyph } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { Icons, PhotoSlotDark, PhotoSlotLight, Space } from '@/ui/theme/tokens';
import { useAppSettings } from '@/ui/theme/hooks/use-app-settings';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

/**
 * Why a photo isn't here. 'arriving' is the ordinary case — the entry
 * landed before its bytes did — and says so quietly; 'unavailable' is a
 * download that has failed enough times to be worth admitting to, rather
 * than looking identical to one still on its way.
 */
export type MissingPhoto = 'arriving' | 'unavailable';

/** Maps an attachment's status to what to tell the reader. Undefined means there is nothing to explain. */
export function missingPhotoFor(status: string | null | undefined): MissingPhoto | undefined {
  if (status === 'fetched') return undefined;
  return status === 'failed' ? 'unavailable' : 'arriving';
}

const NOTES = {
  arriving: { icon: Icons.photoArriving, label: 'ui.photoArriving' },
  unavailable: { icon: Icons.photoUnavailable, label: 'ui.photoUnavailable' },
} as const satisfies Record<MissingPhoto, { icon: IconGlyph; label: string }>;

export type PhotoPlaceholderProps = ViewProps & {
  /** Names the gap instead of leaving the hatch to be read as either loading or broken. */
  missing?: MissingPhoto;
  /** Icon only, for a grid cell too small for a line of text. */
  compact?: boolean;
  /**
   * Retries a photo marked unavailable — the queue's own backoff can be
   * a day long by then, so this is the only way to ask sooner. Has no
   * effect on 'arriving' (already queued) or in a `compact` cell (no
   * room to show it's tappable).
   */
  onRetry?: () => void;
};

/**
 * Stand-in for real photo content — diagonal hatch on `surface`. Every image
 * in the app is a placeholder until media upload/decrypt lands.
 */
export function PhotoPlaceholder({ style, children, missing, compact, onRetry, ...rest }: PhotoPlaceholderProps) {
  const { t } = useTranslation();
  const { scheme } = useAppSettings();
  const theme = useTheme();
  const tints = useTints();
  const hatchFill = scheme === 'dark' ? PhotoSlotDark : PhotoSlotLight;
  const retryable = missing === 'unavailable' && !compact && !!onRetry;

  return (
    <View style={[styles.container, { backgroundColor: hatchFill }, style]} {...rest}>
      {/*
        The Svg is wrapped rather than sitting directly beside `children`.
        Under Fabric, changing siblings makes the mounting layer *move* an
        existing view rather than recreate it, and SvgView cannot be
        re-parented — it throws "addViewAt: view already has a parent" and
        corrupts the native tree, which only a full restart recovers. The
        wrapper is an ordinary ReactViewGroup, so it absorbs the move and
        the SvgView underneath is never touched.
      */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height="100%">
          <Defs>
            <Pattern
              id="hatch"
              width={22}
              height={22}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)">
              <Rect width={22} height={22} fill={hatchFill} />
              <Line x1={0} y1={0} x2={0} y2={22} stroke={tints.hatch} strokeWidth={1} />
            </Pattern>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#hatch)" />
        </Svg>
      </View>
      {missing ? (
        // Always a Pressable, retryable or not, so a photo that arrives
        // mid-download doesn't swap this element's host type out from
        // under it — disabled plus pointerEvents="none" is inert enough
        // to be indistinguishable from the plain View this used to be.
        <Pressable
          style={styles.note}
          pointerEvents={retryable ? 'auto' : 'none'}
          disabled={!retryable}
          onPress={onRetry}
          hitSlop={12}>
          <Icon icon={retryable ? Icons.retryPhoto : NOTES[missing].icon} size={compact ? 15 : 18} color={theme.muted} />
          {compact ? null : (
            <ThemedText type="labelSmall" themeColor="muted">
              {t(retryable ? 'ui.photoUnavailableRetry' : NOTES[missing].label)}
            </ThemedText>
          )}
        </Pressable>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  // Centred over the hatch rather than in the flow, so it sits right
  // whatever shape the slot is — a 4:5 card, a square grid cell.
  note: {
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
