import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { Avatar } from '@/ui/components/avatar/avatar';
import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Fonts, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { getProfile } from '@/data/db';
import { bytesToDataUri, downloadAndCompressImage, pickAndCompressImage, type CompressedImage } from '@/core/photo/image';
import { completeProfileSetup } from '@/features/account/usecases/onboarding';
import { getProfile as getRelayProfile } from '@/features/account/services/account-relay';
import { primeOwnColorSeed } from '@/ui/theme/hooks/use-own-color-seed';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { goPostAuth } from '@/features/invite/services/pending-invite';

export default function ProfileSetupScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  // Only ever set by index.tsx, right after a first-time sign-in — see
  // sign-in.ts's SignInResult. Used purely as initial state below, not
  // re-read after that: this screen's own local edits always win once the
  // user starts typing/picking, and the effect further down only applies
  // suggestedPictureUrl once (empty deps), never overwriting a later
  // manual picture change.
  const { suggestedName, suggestedPictureUrl, onboarding } = useLocalSearchParams<{
    suggestedName?: string;
    suggestedPictureUrl?: string;
    onboarding?: string;
  }>();
  // Route params only carry strings; '1' or absent, same as `certain`
  // and `justJoined` elsewhere.
  const isOnboarding = !!onboarding;
  const [name, setName] = useState(suggestedName ?? '');
  const [picture, setPicture] = useState<CompressedImage | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colorSeed, setColorSeed] = useState<string | undefined>(undefined);

  // Reached only after a successful sign-in, so the relay already has an
  // accountId for this session — read it here rather than wait for
  // "Continue" so the avatar preview has a stable colour to sit on
  // immediately instead of hashing the name as it's typed, letter by
  // letter.
  useEffect(() => {
    getRelayProfile()
      .then((profile) => setColorSeed(primeOwnColorSeed(profile.accountId)))
      .catch((err) => console.error('Failed to read the account profile', err));
  }, []);

  // Reused for editing an existing profile, not just first-time setup —
  // load whatever's already saved so this doesn't look like a blank form
  // for someone who's already told us who they are.
  useEffect(() => {
    getProfile().then((profile) => {
      if (!profile) return;
      setName(profile.name);
      if (profile.picture) {
        setPicture({ uri: bytesToDataUri(profile.picture), bytes: profile.picture });
      }
    });
  }, []);

  // First-time sign-in only (see above) — fetches once, silently gives up
  // on failure (a network hiccup here shouldn't block profile setup; the
  // user can still add a picture manually either way).
  useEffect(() => {
    if (!suggestedPictureUrl) return;
    downloadAndCompressImage(suggestedPictureUrl)
      .then(setPicture)
      .catch((err) => console.error('Failed to fetch suggested profile picture', err));
  }, [suggestedPictureUrl]);

  async function handleAddPicture() {
    const picked = await pickAndCompressImage();
    if (picked) setPicture(picked);
  }

  async function handleContinue() {
    setSaving(true);
    setError(null);
    try {
      await completeProfileSetup({ name: name.trim(), picture: picture?.bytes ?? null });
      await goPostAuth(router);
    } catch (err) {
      console.error('Failed to save profile', err);
      setError(t('onboarding.profile.saveFailed'));
      setSaving(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        {/* Mid-onboarding, back would land on the sign-in screen (or a
            stale Welcome back after Start fresh) with a live session —
            editing from /account keeps it. */}
        <ScreenHeader title={t('onboarding.profile.header')} hideBack={isOnboarding} />

        <KeyboardAvoider style={styles.form}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <ThemedText type="headlineSmall">{t('onboarding.profile.title')}</ThemedText>
            <ThemedText type="bodyMedium" themeColor="secondary" style={styles.body}>
              {t('onboarding.profile.body')}
            </ThemedText>

            <Pressable style={styles.pictureRow} onPress={handleAddPicture}>
              <Avatar size={64} uri={picture?.uri} name={name} colorSeed={colorSeed} />
              <View style={styles.pictureText}>
                <ThemedText type="titleMedium">{t('onboarding.profile.addPicture')}</ThemedText>
                <ThemedText type="labelSmall" themeColor="muted">
                  {t('onboarding.profile.pictureVisibility')}
                </ThemedText>
              </View>
            </Pressable>

            <ThemedText type="labelMedium" style={styles.nameLabel}>
              {t('onboarding.profile.nameLabel')}
            </ThemedText>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t('onboarding.profile.namePlaceholder')}
              placeholderTextColor={theme.faint}
              style={[styles.input, { color: theme.text, borderColor: tints.secondaryButtonBorder }]}
            />
          </ScrollView>

          {error ? (
            <ThemedText type="bodyMedium" themeColor="accent" style={styles.error}>
              {error}
            </ThemedText>
          ) : null}

          <PrimaryButton
            label={name.trim() ? t('onboarding.profile.continue') : t('onboarding.profile.addNameToContinue')}
            disabled={!name.trim() || saving}
            onPress={handleContinue}
            style={styles.continueButton}
          />
        </KeyboardAvoider>
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
  alreadyHaveAccount: {
    alignSelf: 'center',
    marginTop: Spacing.cardListGap,
    paddingVertical: Space.s400,
    paddingHorizontal: Spacing.screenPadding,
  },
  form: {
    flex: 1,
  },
  scrollContent: {
    gap: Spacing.cardListGap,
    paddingBottom: Spacing.cardListGap,
  },
  body: {
    marginTop: -4,
  },
  pictureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s400,
    marginTop: Space.s200,
  },
  pictureText: {
    flex: 1,
    gap: Space.s100,
  },
  nameLabel: {
    marginTop: Space.s200,
  },
  input: {
    height: 60,
    paddingHorizontal: Space.s500,
    borderRadius: Radius.input,
    borderWidth: 1,
    fontFamily: Fonts.sans,
    fontSize: 18,
  },
  continueButton: {
    marginTop: Spacing.cardListGap,
  },
  error: {
    textAlign: 'center',
  },
});
