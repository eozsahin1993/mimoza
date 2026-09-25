/**
 * Hearth design system — literal values from the design handoff, no tokens to resolve.
 * The dim warm ground exists so photographs are the only bright thing on screen.
 */

import { Platform } from 'react-native';

import Album from 'lucide-react-native/icons/album';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import Bookmark from 'lucide-react-native/icons/bookmark';
import Camera from 'lucide-react-native/icons/camera';
import CameraOff from 'lucide-react-native/icons/camera-off';
import Check from 'lucide-react-native/icons/check';
import Clock from 'lucide-react-native/icons/clock';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CloudDownload from 'lucide-react-native/icons/cloud-download';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import Heart from 'lucide-react-native/icons/heart';
import ImagePlus from 'lucide-react-native/icons/image-plus';
import Info from 'lucide-react-native/icons/info';
import Link from 'lucide-react-native/icons/link';
import Lock from 'lucide-react-native/icons/lock';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import Plus from 'lucide-react-native/icons/plus';
import QrCode from 'lucide-react-native/icons/qr-code';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import ShieldOff from 'lucide-react-native/icons/shield-off';
import SquarePen from 'lucide-react-native/icons/square-pen';
import Trash from 'lucide-react-native/icons/trash';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import Users from 'lucide-react-native/icons/users';
import UserX from 'lucide-react-native/icons/user-x';
import X from 'lucide-react-native/icons/x';

import type { IconGlyph } from '@/ui/components/icon';

export const Colors = {
  dark: {
    background: '#14100C',
    surface: '#1D1712',
    raised: '#2A231B',
    accent: '#C08A2E',
    accentBright: '#DCA645',
    accentLabel: '#17120C',
    danger: '#D97A6E',
    text: '#F4EDE2',
    body: '#D8CDBE',
    secondary: '#BEB2A2',
    muted: '#8C8071',
    faint: '#7E7263',
    faintest: '#6E6455',
  },
  light: {
    background: '#F3EDE2',
    surface: '#FFFFFF',
    raised: '#E9E0D1',
    accent: '#A6552F',
    accentBright: '#A6552F',
    accentLabel: '#FFFFFF',
    danger: '#B8503F',
    text: '#231A11',
    body: '#3A2C1D',
    secondary: '#3A2C1D',
    muted: '#8A7B66',
    faint: '#8A7B66',
    faintest: '#8A7B66',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * `raised` is for the few things that float over the page rather than
 * sitting in it — see `SnackbarHost`. `surface` can't do that job: in dark
 * mode it's nine values off `background`, which is the point for a card
 * embedded in the page and useless for something meant to look detached.
 *
 * It moves *away* from the page in both schemes rather than always
 * lighter — lighter in dark mode, darker in light — so the separation
 * doesn't depend on which one you're in. Deliberately not the inverse of
 * the page, bright-on-dark: a light bar would be the brightest thing on a
 * dark screen, and this system reserves that for photographs.
 */

/** Photo placeholder slot background, light mode only — dark mode uses `surface`. */
export const PhotoSlotLight = '#DED4C4';

/** Swap this for terracotta / plum / moss — every other value in the system stays fixed. */
export const AlternateAccents = {
  ochre: '#C08A2E',
  terracotta: '#B4552F',
  plum: '#8C5A6B',
  moss: '#4E6B54',
} as const;

/**
 * The fills an initials avatar can land on — see `avatarTintFor`.
 *
 * One fixed set rather than a per-scheme pair like `Tints`: a tint here is
 * a solid disc, not an overlay, so it carries the contrast for its own
 * label and doesn't care what's behind it. Hence a fixed `AvatarInk` too.
 *
 * Solved for, not darkened by eye. Holding AvatarInk above 4.5:1 while each
 * fill still clears 3:1 against `background` leaves L in [0.116, 0.151], so
 * all eight sit at one luminance and differ only in hue — add a colour by
 * eye and it will miss that band.
 */
export const AvatarTints = [
  '#7B6332', // ochre
  '#94573C', // terracotta
  '#9F4F47', // clay
  '#8F5471', // plum
  '#6E5E93', // indigo
  '#4B698B', // steel
  '#386F71', // teal
  '#3D7244', // moss
] as const;

/** The ink on an `AvatarTints` disc — fixed in both schemes, since the disc under it is. */
export const AvatarInk = '#F4EDE2';

/**
 * The mimoza flower's yellow: the wordmark's petals, and the one badge
 * that counts what's new. Scheme-independent, so anything on it is fixed
 * dark rather than the theme's text colour.
 */
export const Petal = '#F0BE3A';

/**
 * Non-solid fills, one set per scheme via `useTints()` — never the bare
 * export, or a component stops reacting to a scheme switch. Each base rgb
 * is that scheme's own `text`/`accent`/`danger`, so a fill always matches
 * that scheme's solid uses of the same color.
 */
export const Tints = {
  dark: {
    chipIdleBg: 'rgba(245,239,230,0.06)',
    chipIdleBorder: 'rgba(245,239,230,0.10)',
    chipReactedBg: 'rgba(192,138,46,0.18)',
    chipReactedBorder: 'rgba(192,138,46,0.45)',
    privacyWashBg: 'rgba(192,138,46,0.09)',
    privacyWashBorder: 'rgba(192,138,46,0.22)',
    dangerWashBorder: 'rgba(217,122,110,0.35)',
    dangerWashBg: 'rgba(217,122,110,0.12)',
    secondaryButtonBorder: 'rgba(245,239,230,0.2)',
    /** The three edges a `raised` surface can carry — quiet by default, tinted when the message has an outcome. */
    raisedBorder: 'rgba(245,239,230,0.08)',
    /** A card's outline. Stronger than `raisedBorder` in dark, where a dark cover or the hatch would otherwise merge into the background. */
    cardEdge: 'rgba(245,239,230,0.14)',
    raisedAccentBorder: 'rgba(192,138,46,0.30)',
    raisedDangerBorder: 'rgba(217,122,110,0.30)',
  },
  light: {
    chipIdleBg: 'rgba(35,26,17,0.06)',
    chipIdleBorder: 'rgba(35,26,17,0.10)',
    chipReactedBg: 'rgba(166,85,47,0.18)',
    chipReactedBorder: 'rgba(166,85,47,0.45)',
    privacyWashBg: 'rgba(166,85,47,0.09)',
    privacyWashBorder: 'rgba(166,85,47,0.22)',
    dangerWashBorder: 'rgba(184,80,63,0.35)',
    dangerWashBg: 'rgba(184,80,63,0.12)',
    secondaryButtonBorder: 'rgba(35,26,17,0.2)',
    raisedBorder: 'rgba(35,26,17,0.08)',
    cardEdge: 'rgba(35,26,17,0.08)',
    raisedAccentBorder: 'rgba(166,85,47,0.30)',
    raisedDangerBorder: 'rgba(184,80,63,0.30)',
  },
} as const;

export const Fonts = {
  title: 'Outfit_600SemiBold',
  sans: 'Outfit_400Regular',
  sansMedium: 'Outfit_500Medium',
  sansSemiBold: 'Outfit_600SemiBold',
  // 'monospace' is the Android family name; 'ui-monospace' is a CSS generic
  // that Android does not know, and an unknown family falls back to sans.
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }) ?? 'monospace',
} as const;

/**
 * The type scale, named for Material 3's roles and sizes — headline, title,
 * body and label, each Large to Small — so a new style has an obvious home
 * instead of becoming another `somethingTitle`. `code` is ours; neither
 * system names a monospaced style.
 *
 * The names are M3's; the sizes are not. M3's assume Roboto and Apple's
 * assume SF Pro, both of which carry more x-height than Outfit's 0.480 em,
 * so each step is matched optically rather than numerically — set at their
 * numbers this face reads about a twentieth small. `titleLarge` at 20 is
 * iOS's 17pt navigation bar.
 */
export const Type = {
  /** Carries a whole screen on its own. Sign-in, and nothing else so far. */
  headlineLarge: { fontFamily: Fonts.title, fontSize: 30, lineHeight: 30 * 1.12, letterSpacing: 30 * -0.02 },
  /**
   * The one headline in a screen's body, and only ever a sentence — what
   * the screen is *called* goes in `titleLarge`, up in the header. A
   * two-word label set at this size reads like shouting.
   */
  headlineSmall: { fontFamily: Fonts.title, fontSize: 22, lineHeight: 22 * 1.15, letterSpacing: 22 * -0.02 },
  /**
   * Names the surface you're on, screen header or sheet alike — one job,
   * so one token. Chrome rather than content: sans, not the title face, so
   * it never competes with the `headlineSmall` beneath it.
   */
  titleLarge: { fontFamily: Fonts.sansMedium, fontSize: 20, lineHeight: 20 * 1.25, letterSpacing: 20 * -0.01 },
  /** A card or row's own title, and the line an empty state leads with. */
  titleMedium: { fontFamily: Fonts.sansMedium, fontSize: 18, lineHeight: 18 * 1.15, letterSpacing: 18 * -0.01 },
  /** A person's name, wherever one appears — post author, member, profile. */
  titleSmall: { fontFamily: Fonts.sansMedium, fontSize: 16, lineHeight: 16 * 1.3 },
  /** A caption read on its own, with room around it. */
  bodyLarge: { fontFamily: Fonts.sans, fontSize: 16.5, lineHeight: 16.5 * 1.5 },
  bodyMedium: { fontFamily: Fonts.sans, fontSize: 15, lineHeight: 15 * 1.5 },
  bodySmall: { fontFamily: Fonts.sans, fontSize: 14, lineHeight: 14 * 1.5 },
  /** Shares `labelMedium`'s size and separates on weight, as M3's emphasized styles do. */
  labelLarge: { fontFamily: Fonts.sansSemiBold, fontSize: 15, lineHeight: 15 * 1.2 },
  /** Labels a group of cards or a form field — quieter than the titles inside it. */
  labelMedium: { fontFamily: Fonts.sansMedium, fontSize: 15, lineHeight: 15 * 1.3 },
  labelSmall: { fontFamily: Fonts.sans, fontSize: 12.5, lineHeight: 12.5 * 1.4 },
  /** Read aloud and typed in by hand, so it never uses the proportional face. */
  code: {
    fontFamily: Fonts.mono,
    fontSize: 22,
    lineHeight: 22 * 1.3,
    letterSpacing: 22 * 0.13,
    textTransform: 'uppercase',
  },
} as const;

/**
 * Named by what the icon means, not which glyph draws it — so the same
 * affordance can't end up drawn two different ways in two places, and
 * changing one is a single edit here. `satisfies` keeps a typo a compile
 * error instead of a silently missing icon.
 *
 * Imported one deep path at a time rather than from lucide's barrel; see
 * `IconGlyph` for why that matters.
 */
export const Icons = {
  back: ArrowLeft,
  close: X,
  /** Opens a menu of options for the thing it sits on. */
  more: Ellipsis,
  /** Trailing affordance on a row that navigates somewhere. */
  disclosure: ChevronRight,
  add: Plus,
  /** Starts a new post — writing something into the circle, not adding a row to a list. */
  composePost: SquarePen,
  /** Opens the emoji picker on a post nobody has reacted to yet — outline, since it's an invitation rather than a reaction you left. */
  react: Heart,
  comment: MessageCircle,
  send: ArrowUp,
  locked: Lock,
  promote: ShieldCheck,
  demote: ShieldOff,
  removeMember: UserX,
  /** Deletes a photo from the circle for everyone — not "remove me from it". */
  deletePost: Trash,
  /** A photo whose entry has landed but whose bytes haven't yet. */
  photoArriving: CloudDownload,
  /** A photo whose download has failed enough times to stop looking temporary. Also what a failed message is marked with — see `SnackbarHost`. */
  photoUnavailable: CircleAlert,
  /** A failed photo's manual retry, in the post screen. */
  retryPhoto: RefreshCw,
  /** A message about the app rather than about something that just happened. */
  notice: Info,
  /** Something asked for has happened — the message confirming a delete, a copy. */
  done: Check,
  /** Something asked for didn't happen, and won't without help. */
  failed: TriangleAlert,
  /** The circle's album — every photo it holds, not just what's in the feed. */
  album: Album,
  /** Whether one post is kept in that album — the album seen from a single photo. Solid when it is; see `Icon`'s `filled`. */
  inAlbum: Bookmark,
  /** A circle asked to join but not yet let into — waiting on someone else, not on the network. */
  waiting: Clock,
  /** Sends a circle's key to someone who isn't in the room. */
  inviteLink: Link,
  /** Shows that key as a code to scan, for someone who is. */
  inviteCode: QrCode,
  /** Retires the key in circulation and mints a fresh one. */
  replaceKey: RefreshCw,
  /** Centered over an empty photo/cover picker — a plain `add` reads as "add a row," not "add a photo." */
  addPhoto: ImagePlus,
  /** How many people are in a circle — next to the count on its card row. */
  members: Users,
  /** Asks for camera access before a scanner can open. */
  camera: Camera,
  /** Camera access denied — points at Settings instead of a blank preview. */
  cameraOff: CameraOff,
} as const satisfies Record<string, IconGlyph>;

export const Radius = {
  pill: 999,
  circleCard: 18,
  panel: 16,
  input: 14,
  notice: 13,
  bottomSheet: 22,
} as const;

/**
 * The 4pt grid. Named the way Polaris names it: the number is the
 * percentage of the 4px base, so `Space.s400` is 16px and `Space.s200` is
 * 8px. Whole steps only — no 150 or 225 — because a distance that needs a
 * half step is a distance off the grid.
 *
 * The name abstracts the value on purpose: retuning the scale is one edit
 * here rather than a rename of every call site. 4 because it's what the
 * platform lays out on — a view controller's root view takes 16pt side
 * margins, a subview 8pt, and Auto Layout's standard sibling spacing is
 * 8pt.
 */
export const Space = {
  s0: 0,
  s100: 4,
  s200: 8,
  s300: 12,
  s400: 16,
  s500: 20,
  s600: 24,
  s700: 28,
  s800: 32,
  s900: 36,
  s1000: 40,
} as const;

/** Every distance in the app is one of these — anything else fails to compile. */
export type SpaceToken = (typeof Space)[keyof typeof Space];

/**
 * The distances more than one file has to agree on, which `Space` can't
 * express: change `screenPadding` here and every screen moves together,
 * where changing a 24 means finding which 24s meant this and which were
 * coincidence. Reach for `Space` inside a component and for these across
 * components.
 */
export const Spacing = {
  screenPadding: Space.s600,
  cardListGap: Space.s400,
  /**
   * The feed column's inset — captions, action chips, comments, roster
   * rows, and the header above them. Narrower than `screenPadding` so the
   * photographs, which run edge to edge, aren't squeezed by text margins
   * meant for a form.
   */
  feedTextPadding: Space.s500,
  /**
   * The gap above a screen's header row — `ScreenHeader` applies it, so
   * only `circle/index.tsx`, the stack root without one, names it
   * directly.
   *
   * Small because it sits *under* the safe-area inset rather than instead
   * of it: `SafeAreaView`'s edges are `additive` by default, so its
   * padding stacks on the inset. That also makes this the whole gap the
   * eye sees on both platforms — Android's status bar inset is around
   * 24dp against an iPhone's ~59pt, and anything relying on the inset for
   * breathing room reads as cramped there.
   */
  topPadUnderSafeArea: Space.s400,
  gapBetweenPosts: Space.s900,
  pinnedButtonFromBottom: Space.s700,
} as const;

/**
 * A floor, not a fixed height — buttons pair `minHeight` with vertical
 * padding. At the default text size every button is exactly this tall,
 * which is what keeps the Apple and Google buttons identical where they
 * stack; labels scale with Dynamic Type, though, and a fixed height would
 * clip them rather than grow. Comfortably over the 44pt tap target.
 */
export const ButtonHeight = { primary: 52 } as const;

/** Feed/detail posts: 4/5, edge to edge, no radius. Covers/memories: 16/9, radius = Radius.panel. */
export const PhotoAspect = { post: 4 / 5, cover: 16 / 9 } as const;
