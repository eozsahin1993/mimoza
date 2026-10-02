import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Switch, TextInput, View, StyleSheet } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { PhotoPicker } from '@/ui/components/photo-picker';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { PhotoAspect, Radius, Space, Spacing, Type } from '@/ui/theme/tokens';
import { getCircle, listMembers } from '@/data/db';
import { createPost } from '@/features/post/usecases/create-post';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { pickAndCompressImage, type CompressedImage } from '@/core/photo/image';

/** Scroll clearance above the footer button, same idea as the feed's FAB. */
const FOOTER_CLEARANCE = 110;

export default function NewPostScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circleName, setCircleName] = useState('');
  const [memberCount, setMemberCount] = useState(0);
  const [picture, setPicture] = useState<CompressedImage | null>(null);
  const [caption, setCaption] = useState('');
  const [addToAlbum, setAddToAlbum] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!circleId) return;
    Promise.all([getCircle(circleId), listMembers(circleId)]).then(([circle, members]) => {
      setCircleName(circle?.name ?? '');
      setMemberCount(members.length);
    });
  }, [circleId]);

  async function handlePickPhoto() {
    const picked = await pickAndCompressImage();
    if (picked) setPicture(picked);
  }

  async function handlePost() {
    if (!picture || !circleId) return;
    setPosting(true);
    setError(null);
    try {
      await createPost({ circleId, caption: caption.trim(), photo: picture.bytes, inAlbum: addToAlbum });
      router.back();
    } catch (err) {
      console.error('Failed to create post', err);
      setError(t('post.create.failed'));
      setPosting(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader variant="close" title={t('post.create.title')} />

        <View style={styles.postingToRow}>
          <ThemedText type="titleSmall">{circleName}</ThemedText>
          <ThemedText type="labelSmall" themeColor="muted">
            {' '}
            · {t('post.create.audience', { count: memberCount })}
          </ThemedText>
        </View>

        <KeyboardAvoider style={styles.form}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <PhotoPicker
              uri={picture?.uri}
              aspectRatio={PhotoAspect.post}
              label={t('post.create.pickPhoto')}
              onPress={handlePickPhoto}
            />

            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder={t('post.create.captionPlaceholder')}
              placeholderTextColor={theme.faint}
              multiline
              style={[styles.captionInput, { color: theme.text }]}
            />

            <View style={[styles.albumRow, { backgroundColor: tints.chipIdleBg, borderColor: tints.chipIdleBorder }]}>
              <View style={styles.albumText}>
                <ThemedText type="titleSmall">{t('post.create.addToAlbum')}</ThemedText>
                <ThemedText type="labelSmall" themeColor="muted">
                  {t('post.create.albumHint')}
                </ThemedText>
              </View>
              <Switch
                value={addToAlbum}
                onValueChange={setAddToAlbum}
                trackColor={{ false: tints.switchTrack, true: theme.accent }}
                thumbColor={theme.text}
              />
            </View>
          </ScrollView>
        </KeyboardAvoider>
      </ThemedSafeAreaView>

      {/* Outside KeyboardAvoider and absolutely positioned, same as the
          feed's FAB: pinned to the screen itself rather than riding up
          with the keyboard the way a sibling inside KeyboardAvoider
          would. The caption is still reachable above the keyboard; this
          button isn't needed until it's dismissed. */}
      <ThemedSafeAreaView edges={['bottom']} style={styles.footer}>
        {error ? (
          <ThemedText type="bodyMedium" themeColor="accent" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}
        <PrimaryButton
          label={t('post.create.postTo', { circle: circleName })}
          disabled={!picture || posting}
          onPress={handlePost}
        />
      </ThemedSafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
  },
  postingToRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: Space.s200,
    marginBottom: Spacing.cardListGap,
  },
  form: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: Spacing.cardListGap,
    // Clears the absolutely-positioned footer button below — see `footer`.
    paddingBottom: FOOTER_CLEARANCE,
  },
  captionInput: {
    minHeight: 60,
    fontFamily: Type.bodyLarge.fontFamily,
    fontSize: Type.bodyLarge.fontSize,
    lineHeight: Type.bodyLarge.lineHeight,
    textAlignVertical: 'top',
  },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s400,
    borderWidth: 1,
    borderRadius: Radius.notice,
    padding: Spacing.screenPadding,
  },
  albumText: {
    flex: 1,
    gap: Space.s100,
  },
  error: {
    textAlign: 'center',
    marginBottom: Space.s300,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Space.s300,
  },
});
