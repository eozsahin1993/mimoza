import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Image as SvgImage, Rect } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';

import { ON_PHOTO, SCRIM, SCRIM_LOCATIONS } from '@/features/circle/components/circle-card';
import { ReactionChip } from '@/features/post/components/reaction-chip';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { HeaderIconButton } from '@/ui/components/navbar/header-icon-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedText } from '@/ui/theme/themed-text';
import { Icons, PhotoAspect, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { showError } from '@/core/services/messages';
import {
  compressRenderedPng,
  cropAndCompressImage,
  cropRectFor,
  discardFramingSource,
  minZoomFor,
  type CompressedImage,
  type FramingSource,
} from '@/core/photo/image';

const MAX_ZOOM = 4;
/** Below this the photo no longer fills the frame and sits on a blurred copy of itself. */
const FILLS = 0.999;

const BACKDROP_DIM = 0.18;

/**
 * The backdrop file is a few dozen pixels stretched to size, which shows as
 * tiles. It is drawn this many times per axis, each copy shifted a fraction
 * of a tile and averaged in, which smooths the tiles away. Plain image
 * drawing rather than react-native-svg's blur filter, whose strength differs
 * between iOS and Android and is capped on Android.
 */
const BACKDROP_TAPS = 4;
/** How far the backdrop runs past the frame, so every shifted copy still covers it. More than half a tile. */
const BACKDROP_BLEED = 24;

/** Marks where the photo ends while framing. On screen only, never drawn into the saved cover. */
const GUIDE_COLOR = 'rgba(255,255,255,0.9)';

/**
 * A freshly mounted SVG image reports its load, but on Android only the
 * first time Fresco fetches that file; a retry finds it cached and never
 * hears back. Long enough for a real decode, short enough not to feel stuck.
 */
const LOAD_TIMEOUT_MS = 1500;

function clamp(value: number, min: number, max: number) {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

/** Holds the image's centre close enough to the frame's that no edge comes inside the frame; centred on any axis it doesn't fill. */
function bound(offset: number, zoom: number, base: number, frame: number) {
  'worklet';
  const slack = Math.max(0, (base * zoom - frame) / 2);
  return clamp(offset, -slack, slack);
}

type Placement = { x: number; y: number; width: number; height: number };

export type CoverFramerProps = {
  /** From `pickImageToFrame`. The framer owns it from here and deletes its files on the way out. */
  source: FramingSource;
  /** Laid over the frame where the card puts it, so the photo can be framed around it. */
  name?: string;
  onCancel: () => void;
  onDone: (cover: CompressedImage) => void;
};

/**
 * Drag and pinch a picked photo inside a frame that is the circle card at
 * this screen's width, scrim and name included, so what's framed is what
 * the list shows. Pinched below filling the frame, the photo sits on a
 * blurred copy of itself, and that is drawn into the saved cover so every
 * device shows it the same.
 */
export function CoverFramer({ source, name, onCancel, onDone }: CoverFramerProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [saving, setSaving] = useState(false);
  const [preset, setPreset] = useState<'fill' | 'fit' | null>('fill');
  const [composing, setComposing] = useState<Placement | null>(null);
  const svg = useRef<Svg>(null);
  const photoLoaded = useRef<(() => void) | null>(null);

  const zoom = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const lastPan = useSharedValue({ x: 0, y: 0 });
  const lastScale = useSharedValue(1);

  const frameWidth = stage.width - 2 * Spacing.screenPadding;
  const frame = { width: frameWidth, height: frameWidth / PhotoAspect.cover };
  const frameLeft = (stage.width - frame.width) / 2;
  const frameTop = (stage.height - frame.height) / 2;
  const fill = Math.max(frame.width / source.width, frame.height / source.height);
  const baseWidth = source.width * fill;
  const baseHeight = source.height * fill;
  const minZoom = stage.width > 0 ? minZoomFor(source, frame) : 1;
  const canFit = minZoom < FILLS;
  const reach = Math.max(stage.width, stage.height);

  const backdropBox = { width: frame.width + 2 * BACKDROP_BLEED, height: frame.height + 2 * BACKDROP_BLEED };
  const tile = Math.max(backdropBox.width / source.backdropTiles.width, backdropBox.height / source.backdropTiles.height);
  const taps = Array.from({ length: BACKDROP_TAPS }, (_, i) => ((i + 0.5) / BACKDROP_TAPS - 0.5) * tile);
  const backdropShifts = taps.flatMap((dy) => taps.map((dx) => ({ dx, dy })));

  // Deltas rather than totals, so a pan and a pinch running together each
  // add their own movement instead of overwriting the other's.
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => lastPan.set({ x: 0, y: 0 }))
    .onUpdate((event) => {
      const last = lastPan.get();
      lastPan.set({ x: event.translationX, y: event.translationY });
      offsetX.set(bound(offsetX.get() + event.translationX - last.x, zoom.get(), baseWidth, frame.width));
      offsetY.set(bound(offsetY.get() + event.translationY - last.y, zoom.get(), baseHeight, frame.height));
    });

  // About the fingers, not the frame's centre: what's under them stays there.
  const pinch = Gesture.Pinch()
    .onStart(() => lastScale.set(1))
    .onUpdate((event) => {
      const previous = zoom.get();
      const next = clamp(previous * (event.scale / lastScale.get()), minZoom, MAX_ZOOM);
      lastScale.set(event.scale);
      const ratio = next / previous;
      const focalX = event.focalX - stage.width / 2;
      const focalY = event.focalY - stage.height / 2;
      zoom.set(next);
      offsetX.set(bound(focalX - (focalX - offsetX.get()) * ratio, next, baseWidth, frame.width));
      offsetY.set(bound(focalY - (focalY - offsetY.get()) * ratio, next, baseHeight, frame.height));
    });

  // Which option, if either, the photo sits at right now: a pinch to
  // anywhere in between selects neither.
  useAnimatedReaction(
    () => {
      const z = zoom.get();
      if (z <= minZoom + 0.001) return 'fit';
      return Math.abs(z - 1) < 0.001 ? 'fill' : null;
    },
    (now, previous) => {
      if (now !== previous) scheduleOnRN(setPreset, now);
    },
  );

  const imageMotion = useAnimatedStyle(() => ({
    transform: [{ translateX: offsetX.get() }, { translateY: offsetY.get() }, { scale: zoom.get() }],
  }));

  // Laid out at the photo's size rather than scaled with it, so the dashes
  // stay the same size whatever the zoom.
  const guide = useAnimatedStyle(() => {
    const z = zoom.get();
    return {
      opacity: z < FILLS ? 1 : 0,
      left: stage.width / 2 + offsetX.get() - (baseWidth * z) / 2,
      top: stage.height / 2 + offsetY.get() - (baseHeight * z) / 2,
      width: baseWidth * z,
      height: baseHeight * z,
    };
  });

  function animateTo(target: number) {
    zoom.set(withTiming(target));
    offsetX.set(withTiming(0));
    offsetY.set(withTiming(0));
  }

  function handleCancel() {
    discardFramingSource(source);
    onCancel();
  }

  /** Draws the backdrop and photo into one picture, through the SVG already on screen. */
  async function renderShrunk(placement: Placement): Promise<CompressedImage> {
    const loaded = new Promise<void>((resolve) => {
      photoLoaded.current = resolve;
      setTimeout(resolve, LOAD_TIMEOUT_MS);
    });
    setComposing(placement);
    await loaded;
    const png = await new Promise<string>((resolve, reject) => {
      if (!svg.current) return reject(new Error('Cover frame is not mounted.'));
      svg.current.toDataURL(resolve);
    });
    return compressRenderedPng(png);
  }

  async function handleUse() {
    setSaving(true);
    try {
      const scale = zoom.get();
      const offset = { x: offsetX.get(), y: offsetY.get() };
      const cover =
        scale >= FILLS
          ? await cropAndCompressImage(source, cropRectFor(source, frame, scale, offset))
          : await renderShrunk({
              x: frame.width / 2 + offset.x - (baseWidth * scale) / 2,
              y: frame.height / 2 + offset.y - (baseHeight * scale) / 2,
              width: baseWidth * scale,
              height: baseHeight * scale,
            });
      discardFramingSource(source);
      onDone(cover);
    } catch (err) {
      console.error('Failed to frame the cover', err);
      showError(t('circle.details.coverFailed'));
      setComposing(null);
      setSaving(false);
    }
  }

  const frameRect = { left: frameLeft, top: frameTop, width: frame.width, height: frame.height };

  return (
    <Modal animationType="slide" onRequestClose={handleCancel}>
      {/* A Modal is its own native root, so the app's gestures don't reach in here without one. */}
      <GestureHandlerRootView style={styles.fill}>
        {/* Same for safe areas: without a provider of its own, the SafeAreaView
            reads its insets once, mid-slide, and keeps those zeros. */}
        <SafeAreaProvider>
          <ThemedSafeAreaView style={styles.fill}>
            <View style={styles.padded}>
              <ScreenHeader
                hideBack
                title={t('circle.frame.title')}
                actions={
                  <HeaderIconButton
                    icon={Icons.close}
                    accessibilityLabel={t('common.cancel')}
                    disabled={saving}
                    onPress={handleCancel}
                  />
                }
              />
              <ThemedText type="bodyMedium" themeColor="muted">
                {t('circle.frame.hint')}
              </ThemedText>
              {canFit ? (
                <View style={styles.options}>
                  <ReactionChip
                    icon={Icons.fillPhoto}
                    label={t('circle.frame.fill')}
                    reacted={preset === 'fill'}
                    disabled={saving}
                    onPress={() => animateTo(1)}
                  />
                  <ReactionChip
                    icon={Icons.fitPhoto}
                    label={t('circle.frame.fit')}
                    reacted={preset === 'fit'}
                    disabled={saving}
                    onPress={() => animateTo(minZoom)}
                  />
                </View>
              ) : null}
            </View>

            <GestureDetector gesture={Gesture.Simultaneous(pan, pinch)}>
              <View
                style={styles.stage}
                onLayout={(event) => setStage({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
                {stage.width > 0 ? (
                  <>
                    {/* Under the photo, so it only shows where the photo
                        doesn't reach. It is also what gets rendered into
                        the saved cover, so it has to be on screen: Android
                        only loads an SVG image it has drawn. */}
                    <View pointerEvents="none" style={[styles.backdrop, frameRect]}>
                      <Svg ref={svg} width={frame.width} height={frame.height} viewBox={`0 0 ${frame.width} ${frame.height}`}>
                        {/* Copy n at 1/n opacity leaves every copy equally weighted. */}
                        {backdropShifts.map(({ dx, dy }, index) => (
                          <SvgImage
                            key={index}
                            href={{ uri: source.backdrop }}
                            x={dx - BACKDROP_BLEED}
                            y={dy - BACKDROP_BLEED}
                            {...backdropBox}
                            preserveAspectRatio="xMidYMid slice"
                            opacity={1 / (index + 1)}
                          />
                        ))}
                        <Rect width={frame.width} height={frame.height} fill="rgb(20,16,12)" fillOpacity={BACKDROP_DIM} />
                        {composing ? (
                          <SvgImage
                            href={{ uri: source.uri }}
                            {...composing}
                            preserveAspectRatio="none"
                            onLoad={() => photoLoaded.current?.()}
                          />
                        ) : null}
                      </Svg>
                    </View>

                    <Animated.View
                      style={[
                        styles.photoBox,
                        { left: (stage.width - baseWidth) / 2, top: (stage.height - baseHeight) / 2, width: baseWidth, height: baseHeight },
                        imageMotion,
                      ]}>
                      <Image source={{ uri: source.uri }} style={styles.fill} />
                    </Animated.View>
                    <Animated.View pointerEvents="none" style={[styles.guide, guide]} />

                    {/* One border rather than four strips round the frame: a
                        border's inner corner follows its radius, so the
                        cut-out rounds the way the card does. */}
                    <View
                      pointerEvents="none"
                      style={[
                        styles.veil,
                        {
                          left: frameLeft - reach,
                          top: frameTop - reach,
                          width: frame.width + 2 * reach,
                          height: frame.height + 2 * reach,
                          borderWidth: reach,
                          borderRadius: Radius.circleCard + reach,
                          borderColor: theme.background,
                        },
                      ]}
                    />

                    <View pointerEvents="none" style={[styles.frame, frameRect, { borderColor: tints.cardEdge }]}>
                      <LinearGradient colors={SCRIM} locations={SCRIM_LOCATIONS} style={StyleSheet.absoluteFill} />
                      {name ? (
                        <ThemedText type="titleLarge" numberOfLines={1} style={[styles.name, { color: ON_PHOTO }]}>
                          {name}
                        </ThemedText>
                      ) : null}
                    </View>
                  </>
                ) : null}
              </View>
            </GestureDetector>

            <View style={[styles.padded, styles.footer]}>
              <PrimaryButton label={t('circle.frame.use')} disabled={saving} onPress={handleUse} />
            </View>
          </ThemedSafeAreaView>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  padded: {
    paddingHorizontal: Spacing.screenPadding,
  },
  stage: {
    flex: 1,
    overflow: 'hidden',
  },
  backdrop: {
    position: 'absolute',
    borderRadius: Radius.circleCard,
    overflow: 'hidden',
  },
  photoBox: {
    position: 'absolute',
  },
  guide: {
    position: 'absolute',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: GUIDE_COLOR,
  },
  veil: {
    position: 'absolute',
    opacity: 0.85,
  },
  // The card's own edge, radius and name placement.
  frame: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: Radius.circleCard,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  name: {
    paddingHorizontal: Space.s400,
    paddingBottom: Space.s200,
  },
  options: {
    flexDirection: 'row',
    gap: Space.s200,
    marginTop: Space.s400,
  },
  footer: {
    paddingTop: Space.s300,
    paddingBottom: Space.s300,
  },
});
