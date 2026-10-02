import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { PhotoPicker } from '@/ui/components/photo-picker';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Fonts, PhotoAspect, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { pickAndCompressImage, type CompressedImage } from '@/core/photo/image';

/** Scroll clearance above the footer button, same idea as the feed's FAB. */
const FOOTER_CLEARANCE = 110;

export default function NewCircleScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  const [name, setName] = useState('');
  const [cover, setCover] = useState<CompressedImage | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePickCover() {
    const picked = await pickAndCompressImage();
    if (picked) setCover(picked);
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const circle = await createCircle({ name: name.trim(), picture: cover?.bytes });
      router.replace({ pathname: '/circle/feed', params: { circleId: circle.id } });
    } catch (err) {
      console.error('Failed to create circle', err);
      setError(t('circle.create.failed'));
      setCreating(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader variant="close" title={t('circle.create.title')} />

        <KeyboardAvoider style={styles.form}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View>
              <ThemedText type="labelMedium" style={styles.fieldLabel}>
                {t('circle.create.name')}
              </ThemedText>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={t('circle.create.namePlaceholder')}
                placeholderTextColor={theme.faint}
                style={[styles.input, { color: theme.text, borderColor: tints.secondaryButtonBorder }]}
              />
            </View>

            <View>
              <ThemedText type="labelMedium" style={styles.fieldLabel}>
                {t('circle.create.cover')}
              </ThemedText>
              <PhotoPicker
                uri={cover?.uri}
                aspectRatio={PhotoAspect.cover}
                label={t('circle.create.pickCover')}
                onPress={handlePickCover}
              />
            </View>

            <ThemedText type="labelSmall" themeColor="faint" style={styles.footnote}>
              {t('circle.create.footnote')}
            </ThemedText>
          </ScrollView>
        </KeyboardAvoider>
      </ThemedSafeAreaView>

      {/* Outside KeyboardAvoider and absolutely positioned, same as the
          feed's FAB: pinned to the screen itself rather than riding up
          with the keyboard the way a sibling inside KeyboardAvoider
          would. The name field is still reachable above the keyboard;
          this button isn't needed until it's dismissed. */}
      <ThemedSafeAreaView edges={['bottom']} style={styles.footer}>
        {error ? (
          <ThemedText type="bodyMedium" themeColor="accent" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}
        <PrimaryButton label={t('circle.create.submit')} disabled={!name.trim() || creating} onPress={handleCreate} />
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
  input: {
    height: 60,
    paddingHorizontal: Space.s500,
    borderRadius: Radius.input,
    borderWidth: 1,
    fontFamily: Fonts.sans,
    fontSize: 18,
  },
  fieldLabel: {
    marginBottom: Space.s300,
  },
  footnote: {
    textAlign: 'center',
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
