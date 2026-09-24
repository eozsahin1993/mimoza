import * as AppleAuthentication from 'expo-apple-authentication';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { PrivacyInfoModal } from '@/features/account/components/privacy-info-modal';
import { AppleSignInButton, GoogleSignInButton } from '@/features/account/components/social-sign-in-button';
import { LoadingModal } from '@/ui/components/loading-modal';
import { Wordmark } from '@/ui/components/wordmark';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Colors, Space, Spacing } from '@/ui/theme/tokens';
import { getProfile, saveProfile } from '@/data/db';
import { generateUUID } from '@/core/crypto/primitives';
import { signInWithApple, signInWithGoogle } from '@/features/account/usecases/sign-in';
import { getAuthToken } from '@/core/services/keystore/auth-token';
import { goPostAuth } from '@/features/invite/services/pending-invite';
import { enablePushEverywhere } from '@/features/push-notifications/usecases/enable-push';

type Provider = 'apple' | 'google';

export default function WelcomeScreen() {
  const { t } = useTranslation();
  // null = still checking. Runs once per launch; _layout.tsx already
  // guarantees the database is ready before this screen ever mounts.
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  // Local profile data and the relay session are deliberately independent
  // (see sign-in.ts's signOut doc comment) — skipping straight to /circle
  // needs *both*, not just a local profile. Signing out clears the
  // session but not local data, so without this check a signed-out
  // returning user would get redirected straight past this screen and
  // never see the sign-in buttons at all.
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [busyProvider, setBusyProvider] = useState<Provider | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [privacyVisible, setPrivacyVisible] = useState(false);

  // Re-checked on focus, not just mount, so navigating back here post-sign-in still redirects away.
  useFocusEffect(
    useCallback(() => {
      getProfile().then((profile) => setHasProfile(profile !== null));
      getAuthToken().then((token) => setHasSession(token !== null));
    }, []),
  );

  useEffect(() => {
    // Sign in with Apple only exists as a concept on Apple's own
    // platforms — no equivalent to fall back to elsewhere, so the button
    // just doesn't render rather than showing something that always fails.
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  async function handleSignIn(provider: Provider) {
    setBusyProvider(provider);
    try {
      const result =
        provider === 'google'
          ? await signInWithGoogle(() => setIsRecovering(true))
          : await signInWithApple(() => setIsRecovering(true));
      if (result.outcome !== 'success') return;

      // Launch skipped this while signed out, and signing out removed it.
      enablePushEverywhere().catch((error) => console.error('Failed to register for notifications', error));

      // A returning device (local profile already exists — e.g. this was
      // just a re-auth after signing out) has nothing new to fill in.
      if (hasProfile) {
        await goPostAuth(router);
        return;
      }

      // No local profile, but the relay may already have a name for this
      // account — signing in on a new device for an account that has
      // completed setup elsewhere. The relay is what decides that now,
      // not a guess about whether this is "the same person": sign-in
      // always resolves to the same account for the same provider
      // identity, so there is nothing to ask.
      if (result.relayProfile?.name) {
        const now = Date.now();
        await saveProfile({
          accountId: result.relayProfile.accountId,
          name: result.relayProfile.name,
          picture: null,
          deviceId: generateUUID(),
          createdAt: now,
          updatedAt: now,
        });
        await goPostAuth(router);
        return;
      }

      // Brand new account. Always through the form, pre-filled with
      // whatever the provider gave us — profile-setup downloads the
      // suggested picture itself. Nobody gets a name and avatar committed
      // to their circles without having seen them first.
      router.push({
        pathname: '/profile-setup',
        params: {
          suggestedName: result.suggestedName ?? '',
          suggestedPictureUrl: result.suggestedPictureUrl ?? '',
          onboarding: '1',
        },
      });
    } catch (err) {
      console.error(`${provider} sign-in failed`, err);
      const providerLabel = provider === 'apple' ? 'Apple' : 'Google';
      // Only suggest the other provider if it's actually on offer — Apple
      // isn't available at all on this device (see appleAvailable above),
      // so telling an Android user to "try Apple instead" would be wrong.
      const otherLabel = provider === 'apple' ? 'Google' : appleAvailable ? 'Apple' : null;
      Alert.alert(
        t('onboarding.signInFailedTitle'),
        otherLabel
          ? t('onboarding.signInFailedTryOther', { provider: providerLabel, other: otherLabel })
          : t('onboarding.signInFailed', { provider: providerLabel }),
      );
    } finally {
      setBusyProvider(null);
      setIsRecovering(false);
    }
  }

  if (hasProfile === null || hasSession === null) {
    // Avoids a flash of the Welcome screen for returning users while we check.
    return <ThemedView style={styles.screen} />;
  }

  if (hasProfile && hasSession) {
    return <Redirect href="/circle" />;
  }

  return (
    <ThemedView style={styles.screen}>
      <View style={styles.photo}>
        <Image source={require('@/assets/images/welcome-photo.jpg')} style={StyleSheet.absoluteFill} contentFit="cover" />
        {/* Top scrim keeps the status bar legible over the photo. */}
        <LinearGradient colors={['rgba(0,0,0,0.45)', 'transparent']} style={styles.photoScrim} pointerEvents="none" />
        {/* Radial from the bottom-left corner so only the wordmark's corner goes dark — a full-width
            band would shade the faces too. Fades out before any face in this photo; recheck if it changes. */}
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <RadialGradient id="wordmarkScrim" cx="0" cy="1" fx="0" fy="1" rx="0.95" ry="0.48">
              <Stop offset="0" stopColor="#000" stopOpacity={0.9} />
              <Stop offset="0.35" stopColor="#000" stopOpacity={0.75} />
              <Stop offset="0.7" stopColor="#000" stopOpacity={0.35} />
              <Stop offset="1" stopColor="#000" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#wordmarkScrim)" />
        </Svg>
        {/* Dark-theme text in both schemes: this sits on the photo, not the page,
            and the light scheme's brown would disappear into it. */}
        <Wordmark color={Colors.dark.text} style={styles.wordmark} />
      </View>

      <ThemedSafeAreaView edges={['bottom']} style={styles.content}>
        <ThemedText type="headlineLarge">{t('onboarding.headline')}</ThemedText>
        <ThemedText type="bodyMedium" themeColor="secondary" style={styles.body}>
          {t('onboarding.intro')}
        </ThemedText>

        <View style={styles.actions}>
          {appleAvailable ? (
            <AppleSignInButton disabled={busyProvider !== null} onPress={() => handleSignIn('apple')} />
          ) : null}
          <GoogleSignInButton disabled={busyProvider !== null} onPress={() => handleSignIn('google')} />
        </View>

        <Pressable style={styles.footer} onPress={() => setPrivacyVisible(true)}>
          <ThemedText type="labelSmall" themeColor="muted">
            {t('onboarding.privacyLink')}
          </ThemedText>
        </Pressable>
      </ThemedSafeAreaView>

      <PrivacyInfoModal visible={privacyVisible} onClose={() => setPrivacyVisible(false)} />

      <LoadingModal visible={isRecovering} label={t('onboarding.recoveringTitle')} sublabel={t('onboarding.recoveringMessage')} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  photo: {
    flex: 1.1,
    overflow: 'hidden',
  },
  photoScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 140,
  },
  wordmark: {
    position: 'absolute',
    left: Spacing.screenPadding,
    bottom: 18,
  },
  content: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Space.s800,
    gap: Spacing.cardListGap,
  },
  body: {
    marginTop: Space.s0,
  },
  actions: {
    gap: Space.s300,
    marginTop: Space.s400,
  },
  footer: {
    alignSelf: 'center',
    paddingVertical: Space.s200,
  },
});
