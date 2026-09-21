import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { useLocales } from 'expo-localization';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { Avatar } from '@/ui/components/avatar/avatar';
import { LoadingModal } from '@/ui/components/loading-modal';
import { OptionSheet } from '@/ui/components/option-sheet';
import { PrivacyInfoModal } from '@/features/account/components/privacy-info-modal';
import { ReactionChip } from '@/features/post/components/reaction-chip';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { SettingsGroups, type SettingsGroup } from '@/ui/components/settings-group';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Space, Spacing } from '@/ui/theme/tokens';
import { getProfile, listCircles, type Profile } from '@/data/db';
import { deleteAccount, finishAccountDeletionIfPending, isAccountDeletionPending } from '@/features/account/usecases/delete-account';
import { resetEverythingForTesting } from '@/features/dev/dev-reset';
import { logTestPushPayload } from '@/features/dev/dev-test-push';
import { signOut } from '@/features/account/usecases/sign-in';
import { InvitePushLevels, invitePushLevelForMask, PushLevels, type PushLevelId } from '@/features/push-notifications/usecases/push-preferences';
import { refreshPushSnapshot } from '@/features/push-notifications/usecases/push-snapshot';
import { applyInvitePushMask } from '@/features/invite/usecases/invite-push';
import { Languages, resolveLanguage, type LanguagePreference } from '@/core/i18n/languages';
import { useAppSettings } from '@/ui/theme/hooks/use-app-settings';
import { useOwnColorSeed } from '@/ui/theme/hooks/use-own-color-seed';
import { useTints } from '@/ui/theme/hooks/use-theme';
import { bytesToDataUri } from '@/core/photo/image';
import type { ThemePreference } from '@/core/services/settings';

/** How often to check whether the background erasure has finished while this screen waits on it. */
const DELETION_POLL_MS = 2_000;

/** From app.json's "version" — Constants.expoConfig is only ever missing in a context this screen doesn't run in. */
const appVersion = Constants.expoConfig?.version ?? 'Unknown';

/**
 * What someone is actually running, as two numbers they can read out: the
 * build that shipped the native app, and the CI run that published the
 * JavaScript on top of it. They differ once an update lands, which is the
 * only way to tell an updated app from a fresh install of the same build.
 *
 * The build number comes from the binary rather than the config — after an
 * update the config is the one the update was exported with.
 */
function buildLabel(): string {
  const native = Application.nativeBuildVersion;
  const js = (Constants.expoConfig?.extra as { jsBuild?: string } | undefined)?.jsBuild;
  if (!native) return '';
  return js && js !== native ? ` (${native}.${js})` : ` (${native})`;
}

export default function AccountScreen() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const deviceLanguage = resolveLanguage('system', useLocales());
  const tints = useTints();
  const ownColorSeed = useOwnColorSeed();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [resettingDevData, setResettingDevData] = useState(false);
  const [levelPicker, setLevelPicker] = useState(false);
  const [inviteLevelPicker, setInviteLevelPicker] = useState(false);
  const [languagePicker, setLanguagePicker] = useState(false);
  // Gates the "bring over" direction: adopting another account's seed
  // would strand any circle this device already joined under its own.
  const [hasCircles, setHasCircles] = useState(true);
  // Set once account deletion is confirmed. From here the screen only
  // ever shows the "deleting" state — there's nothing left to cancel.
  const [deletingAccount, setDeletingAccount] = useState(false);
  const deletionPollInFlight = useRef(false);

  // Polls rather than waiting on the 30s scheduler: deletion still
  // finishes via finishAccountDeletionIfPending either way (it dedupes
  // against this call), but a user staring at a spinner shouldn't wait
  // half a minute for the first check.
  useEffect(() => {
    if (!deletingAccount) return;

    const timer = setInterval(async () => {
      if (deletionPollInFlight.current) return;
      deletionPollInFlight.current = true;
      try {
        await finishAccountDeletionIfPending();
        if (!(await isAccountDeletionPending())) {
          clearInterval(timer);
          router.replace('/');
        }
      } catch (err) {
        console.error('Failed to check on account deletion', err);
      } finally {
        deletionPollInFlight.current = false;
      }
    }, DELETION_POLL_MS);

    return () => clearInterval(timer);
  }, [deletingAccount]);

  useFocusEffect(
    useCallback(() => {
      getProfile().then(setProfile);
      listCircles().then((circles) => setHasCircles(circles.length > 0));
    }, []),
  );

  const appearanceOptions: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: t('settings.appearanceSystem') },
    { value: 'light', label: t('settings.appearanceLight') },
    { value: 'dark', label: t('settings.appearanceDark') },
  ];

  // Each language by its own name, with what it's called in the current one
  // underneath — the name is what someone stuck in the wrong language can read.
  const languageOptions = [
    {
      id: 'system' as LanguagePreference,
      label: t('settings.languageSystem'),
      description: Languages.find((language) => language.code === deviceLanguage)?.name,
    },
    ...Languages.map((language) => ({
      id: language.code as LanguagePreference,
      label: language.name,
      description: t(`settings.languageNames.${language.code}`),
    })),
  ];

  const pushLevelOptions = PushLevels.map((level) => ({ id: level.id, label: t(`settings.pushLevels.${level.id}`) }));
  const invitePushLevelOptions = InvitePushLevels.map((level) => ({ id: level.id, label: t(`settings.invitePushLevels.${level.id}`) }));

  /** Same shape the circle screen uses — one list, one row component, one set of spacings. */
  const settingsGroups: SettingsGroup[] = [
    {
      title: t('settings.language'),
      rows: [
        {
          label: t('settings.languageRow'),
          control: {
            kind: 'value',
            text: languageOptions.find((option) => option.id === settings.language)?.label ?? '',
          },
          onPress: () => setLanguagePicker(true),
        },
      ],
    },
    {
      title: t('settings.notifications'),
      footnote: t('settings.notificationsFootnote'),
      rows: [
        {
          label: t('settings.newCirclesRow'),
          control: { kind: 'value', text: t(`settings.pushLevels.${settings.defaultPushLevel as PushLevelId}`) },
          onPress: () => setLevelPicker(true),
        },
        {
          label: t('settings.invitesRow'),
          control: { kind: 'value', text: t(`settings.invitePushLevels.${invitePushLevelForMask(settings.invitePushMask)}`) },
          onPress: () => setInviteLevelPicker(true),
        },
      ],
    },
    {
      title: t('settings.devices'),
      // No list and no count: nothing tracks which devices hold your keys,
      // and nothing could revoke one if it did — every device with the
      // seed derives the same identity, so the log can't tell them apart.
      // A list you can't act on reads as control you don't have.
      footnote: t('settings.devicesFootnote'),
      rows: [
        {
          label: t('settings.addDevice'),
          description: t('settings.addDeviceDescription'),
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/scan-device'),
        },
        !hasCircles && {
          label: t('settings.bringOver'),
          description: t('settings.bringOverDescription'),
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/transfer'),
        },
      ],
    },
    {
      title: t('settings.recovery'),
      rows: [
        {
          label: t('settings.recoveryPhrase'),
          description: t('settings.recoveryPhraseDescription'),
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/recovery'),
        },
        {
          label: t('settings.privacy'),
          description: t('settings.privacyDescription'),
          control: { kind: 'navigate' },
          onPress: () => setPrivacyVisible(true),
        },
      ],
    },
    {
      title: t('settings.about'),
      rows: [
        {
          label: t('settings.credits'),
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/credits'),
        },
      ],
    },
    {
      title: t('settings.account'),
      rows: [
        {
          label: signingOut ? t('settings.signingOut') : t('settings.signOut'),
          disabled: signingOut,
          onPress: handleSignOut,
        },
        {
          label: t('settings.deleteAccount'),
          description: t('settings.deleteAccountDescription'),
          destructive: true,
          onPress: handleDeleteAccount,
        },
      ],
    },
  ];

  // Its own group, kept separate from settingsGroups: not actionable, so
  // it isn't a row, and it belongs after every real setting but ahead of
  // developer tools — sandwiched between two renders of SettingsGroups
  // rather than sortable into one flat list.
  const developerGroup: SettingsGroup = {
    title: 'Developer',
    rows: [
      __DEV__ && {
        label: resettingDevData ? 'Resetting…' : 'Reset all local data',
        description:
          '__DEV__ only. Wipes circles, keys, the master seed, and the database schema, so a changed migration actually re-runs.',
        destructive: true,
        disabled: resettingDevData,
        onPress: handleDevReset,
      },
      __DEV__ && {
        label: 'Log a test push payload',
        description: '__DEV__ only. Logs a simctl push payload this device can decrypt, for testing the iOS notification extension.',
        control: { kind: 'navigate' as const },
        onPress: () => void logTestPushPayload(),
      },
    ],
  };

  function handleDevReset() {
    Alert.alert('Reset all local data? (dev only)', 'Wipes every circle, key, the master seed, and the database itself. No undo.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          setResettingDevData(true);
          try {
            await resetEverythingForTesting();
            router.replace('/');
          } finally {
            setResettingDevData(false);
          }
        },
      },
    ]);
  }

  function handleSignOut() {
    Alert.alert(
      t('settings.signOutTitle'),
      t('settings.signOutMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.signOutConfirm'),
          onPress: async () => {
            setSigningOut(true);
            try {
              await signOut();
              router.replace('/');
            } finally {
              setSigningOut(false);
            }
          },
        },
      ],
    );
  }

  function handleDeleteAccount() {
    Alert.alert(
      t('settings.deleteTitle'),
      t('settings.deleteMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.deleteConfirm'),
          style: 'destructive',
          onPress: async () => {
            // No way back from here, so the screen commits to the
            // deleting state before deleteAccount even starts — nothing
            // below it is a decision the user still gets to make.
            setDeletingAccount(true);
            try {
              await deleteAccount();
            } catch (err) {
              console.error('Failed to start account deletion', err);
              setDeletingAccount(false);
            }
          },
        },
      ],
    );
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('settings.title')} />

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.profileRow}>
            <Avatar
              size={72}
              uri={profile?.picture ? bytesToDataUri(profile.picture) : undefined}
              name={profile?.name}
              colorSeed={ownColorSeed}
            />
            <View style={styles.profileText}>
              <ThemedText type="titleSmall" numberOfLines={1}>
                {profile?.name || t('settings.addName')}
              </ThemedText>
              <ThemedText type="labelSmall" themeColor="muted">
                {t('settings.nameVisibility')}
              </ThemedText>
            </View>
            <Pressable
              style={[styles.editButton, { borderColor: tints.secondaryButtonBorder }]}
              onPress={() => router.push('/profile-setup')}>
              <ThemedText type="labelLarge">{t('settings.edit')}</ThemedText>
            </Pressable>
          </View>


          <View style={styles.section}>
            <ThemedText type="labelMedium" style={styles.sectionLabel}>
              {t('settings.appearance')}
            </ThemedText>

            <View style={styles.appearanceRow}>
              {appearanceOptions.map((option) => (
                <ReactionChip
                  key={option.value}
                  label={option.label}
                  reacted={settings.themePreference === option.value}
                  onPress={() => updateSettings({ themePreference: option.value })}
                  style={styles.appearanceChip}
                />
              ))}
            </View>
          </View>

          <SettingsGroups groups={settingsGroups} />

          <View style={styles.version}>
            <ThemedText type="labelSmall" themeColor="faint">
              v{appVersion}{buildLabel()}
            </ThemedText>
          </View>

          <SettingsGroups groups={[developerGroup]} />
        </ScrollView>
      </ThemedSafeAreaView>

      <OptionSheet
        visible={levelPicker}
        onClose={() => setLevelPicker(false)}
        title={t('settings.notifyMeAbout')}
        options={pushLevelOptions}
        selected={settings.defaultPushLevel as PushLevelId}
        onSelect={(level) => {
          setLevelPicker(false);
          updateSettings({ defaultPushLevel: level });
        }}
      />

      <OptionSheet
        visible={inviteLevelPicker}
        onClose={() => setInviteLevelPicker(false)}
        title={t('settings.invitesRow')}
        options={invitePushLevelOptions}
        selected={invitePushLevelForMask(settings.invitePushMask)}
        onSelect={(id) => {
          setInviteLevelPicker(false);
          const mask = InvitePushLevels.find((level) => level.id === id)?.mask ?? 0;
          updateSettings({ invitePushMask: mask });
          applyInvitePushMask(mask).catch((err) => console.error('Failed to apply invite notifications', err));
        }}
      />
      <OptionSheet
        visible={languagePicker}
        onClose={() => setLanguagePicker(false)}
        title={t('settings.language')}
        options={languageOptions}
        selected={settings.language}
        onSelect={(language) => {
          setLanguagePicker(false);
          // After the write, since the snapshot reads the stored setting.
          void updateSettings({ language }).then(refreshPushSnapshot);
        }}
      />

      <PrivacyInfoModal visible={privacyVisible} onClose={() => setPrivacyVisible(false)} />

      <LoadingModal
        visible={deletingAccount}
        label={t('settings.deleting')}
        sublabel={t('settings.deletingDetail')}
      />
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
  content: {
    paddingBottom: Spacing.cardListGap * 2,
    gap: Spacing.cardListGap * 1.5,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s400,
  },
  profileText: {
    flex: 1,
    gap: Space.s100,
  },
  editButton: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: Space.s500,
    paddingVertical: Space.s300,
  },
  section: {
    gap: Space.s300,
  },
  sectionLabel: {
    marginBottom: Space.s0,
  },
  appearanceRow: {
    flexDirection: 'row',
    gap: Space.s300,
  },
  appearanceChip: {
    flex: 1,
    justifyContent: 'center',
  },
  version: {
    alignItems: 'center',
  },
});
