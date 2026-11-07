import type { LucideIcon } from 'lucide-react-native';

/**
 * A glyph from the icon set, as the component that draws it rather than a
 * name to look up — see `Icons` in `theme/tokens.ts`, which lists the ones
 * the app uses. Deep imports plus a component reference are what keep
 * the bundle to the two dozen icons actually used: Metro doesn't
 * tree-shake, so a string-keyed registry over lucide's barrel would ship
 * all ~1,600.
 */
export type IconGlyph = LucideIcon;

export type IconProps = {
  icon: IconGlyph;
  size: number;
  color: string;
  /** Solid rather than outline, for a glyph with an on state. */
  filled?: boolean;
};

/**
 * Every icon in the app goes through here, so weight is one edit rather
 * than a number repeated at forty call sites.
 */
export function Icon({ icon: Glyph, size, color, filled }: IconProps) {
  return <Glyph size={size} color={color} fill={filled ? color : 'none'} strokeWidth={STROKE_WIDTH} />;
}

/** Lucide's own default. Feather drew at the same weight, so nothing shifts. */
const STROKE_WIDTH = 2;
