import { type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import Svg, { Circle, Ellipse, G, Path } from 'react-native-svg';
import { Petal } from '@/ui/theme/tokens';

import { useTheme } from '@/ui/theme/hooks/use-theme';

/** Colours of the app icon's bloom, flattened: a gradient is invisible at this size. */
const HEART = '#FFF3D1';
const PETAL_ANGLES = [0, 60, 120, 180, 240, 300];
const DEFAULT_SIZE = 28;

/**
 * Outfit Bold outlines in font units (1000/em), baseline at y = 0, tracked
 * -40. Drawn as paths rather than <Text> because iOS and Android place the
 * baseline differently inside a line box, so a bloom positioned against text
 * layout lands at a different height on each. Regenerate from
 * assets/fonts/Outfit_700Bold.ttf if the font or tracking changes.
 */
const PLAIN = {
  width: 3459,
  top: 721,
  bottom: -11,
  d: 'M54 0V-486H207V0ZM365 0V-284Q365 -321 342.5 -341.5Q320 -362 287 -362Q264 -362 246 -352.5Q228 -343 217.5 -326Q207 -309 207 -284L148 -310Q148 -368 173 -409.5Q198 -451 241 -473.5Q284 -496 338 -496Q389 -496 429.5 -473Q470 -450 494 -409Q518 -368 518 -311V0ZM676 0V-284Q676 -321 653.5 -341.5Q631 -362 598 -362Q575 -362 557 -352.5Q539 -343 528.5 -326Q518 -309 518 -284L430 -296Q432 -358 459.5 -402.5Q487 -447 532.5 -471.5Q578 -496 635 -496Q691 -496 734.5 -472.5Q778 -449 803.5 -405.5Q829 -362 829 -301V0Z M887 0V-486H1040V0ZM964 -553Q928 -553 904.5 -577.5Q881 -602 881 -637Q881 -673 904.5 -697Q928 -721 964 -721Q1000 -721 1023 -697Q1046 -673 1046 -637Q1046 -602 1023 -577.5Q1000 -553 964 -553Z M1108 0V-486H1261V0ZM1419 0V-284Q1419 -321 1396.5 -341.5Q1374 -362 1341 -362Q1318 -362 1300 -352.5Q1282 -343 1271.5 -326Q1261 -309 1261 -284L1202 -310Q1202 -368 1227 -409.5Q1252 -451 1295 -473.5Q1338 -496 1392 -496Q1443 -496 1483.5 -473Q1524 -450 1548 -409Q1572 -368 1572 -311V0ZM1730 0V-284Q1730 -321 1707.5 -341.5Q1685 -362 1652 -362Q1629 -362 1611 -352.5Q1593 -343 1582.5 -326Q1572 -309 1572 -284L1484 -296Q1486 -358 1513.5 -402.5Q1541 -447 1586.5 -471.5Q1632 -496 1689 -496Q1745 -496 1788.5 -472.5Q1832 -449 1857.5 -405.5Q1883 -362 1883 -301V0Z M2175 11Q2100 11 2039.5 -22.5Q1979 -56 1944 -114Q1909 -172 1909 -244Q1909 -316 1944 -373Q1979 -430 2039 -463.5Q2099 -497 2175 -497Q2251 -497 2311 -464Q2371 -431 2406 -373.5Q2441 -316 2441 -244Q2441 -172 2406 -114Q2371 -56 2311 -22.5Q2251 11 2175 11ZM2175 -128Q2208 -128 2233 -142.5Q2258 -157 2271.5 -183.5Q2285 -210 2285 -244Q2285 -278 2271 -303.5Q2257 -329 2232.5 -343.5Q2208 -358 2175 -358Q2143 -358 2118 -343.5Q2093 -329 2079 -303Q2065 -277 2065 -243Q2065 -210 2079 -183.5Q2093 -157 2118 -142.5Q2143 -128 2175 -128Z M2446 -90 2690 -397H2876L2632 -90ZM2446 0V-90L2555 -128H2870V0ZM2464 -358V-486H2876V-397L2768 -358Z M3121 10Q3054 10 3001.5 -23Q2949 -56 2918.5 -113Q2888 -170 2888 -243Q2888 -316 2918.5 -373Q2949 -430 3001.5 -463Q3054 -496 3121 -496Q3170 -496 3209.5 -477Q3249 -458 3274 -424.5Q3299 -391 3302 -348V-138Q3299 -95 3274.5 -61.5Q3250 -28 3210 -9Q3170 10 3121 10ZM3152 -128Q3201 -128 3231 -160.5Q3261 -193 3261 -243Q3261 -277 3247.5 -303Q3234 -329 3209.5 -343.5Q3185 -358 3153 -358Q3121 -358 3096.5 -343.5Q3072 -329 3057.5 -303Q3043 -277 3043 -243Q3043 -210 3057 -184Q3071 -158 3096 -143Q3121 -128 3152 -128ZM3255 0V-131L3278 -249L3255 -367V-486H3405V0Z',
};
const WITH_BLOOM = {
  width: 3463,
  top: 721,
  bottom: -47,
  d: 'M54 0V-486H207V0ZM365 0V-284Q365 -321 342.5 -341.5Q320 -362 287 -362Q264 -362 246 -352.5Q228 -343 217.5 -326Q207 -309 207 -284L148 -310Q148 -368 173 -409.5Q198 -451 241 -473.5Q284 -496 338 -496Q389 -496 429.5 -473Q470 -450 494 -409Q518 -368 518 -311V0ZM676 0V-284Q676 -321 653.5 -341.5Q631 -362 598 -362Q575 -362 557 -352.5Q539 -343 528.5 -326Q518 -309 518 -284L430 -296Q432 -358 459.5 -402.5Q487 -447 532.5 -471.5Q578 -496 635 -496Q691 -496 734.5 -472.5Q778 -449 803.5 -405.5Q829 -362 829 -301V0Z M887 0V-486H1040V0ZM964 -553Q928 -553 904.5 -577.5Q881 -602 881 -637Q881 -673 904.5 -697Q928 -721 964 -721Q1000 -721 1023 -697Q1046 -673 1046 -637Q1046 -602 1023 -577.5Q1000 -553 964 -553Z M1108 0V-486H1261V0ZM1419 0V-284Q1419 -321 1396.5 -341.5Q1374 -362 1341 -362Q1318 -362 1300 -352.5Q1282 -343 1271.5 -326Q1261 -309 1261 -284L1202 -310Q1202 -368 1227 -409.5Q1252 -451 1295 -473.5Q1338 -496 1392 -496Q1443 -496 1483.5 -473Q1524 -450 1548 -409Q1572 -368 1572 -311V0ZM1730 0V-284Q1730 -321 1707.5 -341.5Q1685 -362 1652 -362Q1629 -362 1611 -352.5Q1593 -343 1582.5 -326Q1572 -309 1572 -284L1484 -296Q1486 -358 1513.5 -402.5Q1541 -447 1586.5 -471.5Q1632 -496 1689 -496Q1745 -496 1788.5 -472.5Q1832 -449 1857.5 -405.5Q1883 -362 1883 -301V0Z M2450 -90 2694 -397H2880L2636 -90ZM2450 0V-90L2559 -128H2874V0ZM2468 -358V-486H2880V-397L2772 -358Z M3125 10Q3058 10 3005.5 -23Q2953 -56 2922.5 -113Q2892 -170 2892 -243Q2892 -316 2922.5 -373Q2953 -430 3005.5 -463Q3058 -496 3125 -496Q3174 -496 3213.5 -477Q3253 -458 3278 -424.5Q3303 -391 3306 -348V-138Q3303 -95 3278.5 -61.5Q3254 -28 3214 -9Q3174 10 3125 10ZM3156 -128Q3205 -128 3235 -160.5Q3265 -193 3265 -243Q3265 -277 3251.5 -303Q3238 -329 3213.5 -343.5Q3189 -358 3157 -358Q3125 -358 3100.5 -343.5Q3076 -329 3061.5 -303Q3047 -277 3047 -243Q3047 -210 3061 -184Q3075 -158 3100 -143Q3125 -128 3156 -128ZM3259 0V-131L3282 -249L3259 -367V-486H3409V0Z',
  /** Centred on the x-height (486 units), 580 units across. */
  bloomX: 2177,
  bloomY: -243,
  bloomSize: 580,
};

type WordmarkProps = Pick<ViewProps, 'accessibilityRole' | 'accessibilityLabel'> & {
  /** The em size, as a font size would be. */
  size?: number;
  /** The bloom in place of the "o" — the home screen only; everywhere else the name is plain. */
  withBloom?: boolean;
  /** Defaults to the scheme's `text`; override only where it sits on a photo. */
  color?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * The "mimoza" logo in Outfit Bold — only where the name stands alone as the
 * brand, never inside a sentence. splash-wordmark.png is a render of the plain
 * version; update both together.
 */
export function Wordmark({
  size = DEFAULT_SIZE,
  withBloom = false,
  color,
  style,
  accessibilityRole,
  accessibilityLabel,
}: WordmarkProps) {
  const theme = useTheme();
  const glyphs = withBloom ? WITH_BLOOM : PLAIN;
  const height = glyphs.top - glyphs.bottom;

  return (
    <Svg
      width={(glyphs.width / 1000) * size}
      height={(height / 1000) * size}
      viewBox={`0 ${-glyphs.top} ${glyphs.width} ${height}`}
      style={style}
      accessible
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? 'mimoza'}>
      <Path d={glyphs.d} fill={color ?? theme.text} />
      {withBloom ? (
        <G transform={`translate(${WITH_BLOOM.bloomX} ${WITH_BLOOM.bloomY}) scale(${WITH_BLOOM.bloomSize / 680})`}>
          <G fill={Petal}>
            {PETAL_ANGLES.map((angle) => (
              <Ellipse key={angle} cy={-178} rx={125} ry={160} transform={`rotate(${angle})`} />
            ))}
          </G>
          <Circle r={98} fill={HEART} />
        </G>
      ) : null}
    </Svg>
  );
}
