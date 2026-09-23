import 'react-native-get-random-values';

import { Buffer } from 'buffer';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';

import { EnvBadge } from '@/ui/components/env-badge';
import { Snackbar } from '@/ui/components/snackbar';
import { Colors } from '@/ui/theme/tokens';
import { initDatabase } from '@/data/db';
import { enablePushEverywhere } from '@/features/push-notifications/usecases/enable-push';
import { startPushTapRouting } from '@/features/push-notifications/services/tap';
import { AppSettingsProvider, useAppSettings } from '@/ui/theme/hooks/use-app-settings';
import { useMessages } from '@/core/hooks/use-messages';
import { useSessionExpiry } from '@/core/hooks/use-session-expiry';
import { getAppSettings, type AppSettings } from '@/core/services/settings';
import { applyLanguage } from '@/core/i18n/i18n';
import { startJankMonitor } from '@/core/utils/timing';
import { startSyncScheduler } from '@/core/sync/scheduler';

// drizzle-orm's default sqlite blob column (posts.photo, circleMembers.picture,
// deviceProfile.picture) calls the global `Buffer` directly with no existence
// check — present in Node/Jest, absent from Hermes on-device, so every blob
// read/write throws `ReferenceError: Property 'Buffer' doesn't exist` without
// this polyfill.
global.Buffer = global.Buffer ?? Buffer;

SplashScreen.preventAutoHideAsync();

// Deep-linking straight into a route like join/[code] would otherwise make
// it the *only* stack entry — nothing behind it for a sheet to sit over,
// and no way back. This synthesizes `index` underneath any deep-linked
// route, and index.tsx's own hasProfile/hasSession check already resolves
// that to /circle for a signed-in user (or the welcome screen otherwise) —
// same logic a normal cold app open already goes through, not a second
// copy of it. Normal (non-deep-link) navigation is unaffected.
export const unstable_settings = {
  initialRouteName: 'index',
};

const MimozaDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: Colors.dark.background,
    card: Colors.dark.surface,
    text: Colors.dark.text,
    primary: Colors.dark.accent,
    border: Colors.dark.faintest,
  },
};

const MimozaLightTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: Colors.light.background,
    card: Colors.light.surface,
    text: Colors.light.text,
    primary: Colors.light.accent,
    border: Colors.light.muted,
  },
};

/** Picks the nav theme off the resolved scheme (system/light/dark preference already applied) rather than the raw OS setting, so the Appearance picker in /account actually changes anything. */
function AppShell() {
  const { scheme } = useAppSettings();
  const { message, visible, dismiss, settle } = useMessages();
  useSessionExpiry();

  return (
    <ThemeProvider value={scheme === 'dark' ? MimozaDarkTheme : MimozaLightTheme}>
      <Stack
        screenOptions={{
          headerShown: false,
          // iOS 26's scroll-edge material follows the trait collection, not
          // the app's theme — it can render light over a dark screen.
          scrollEdgeEffects: { bottom: 'hidden', top: 'hidden', left: 'hidden', right: 'hidden' },
        }}
      />
      {/* Outside the stack, so a message survives the screen that caused
          it — including one that navigates away as it reports. */}
      <Snackbar message={message} visible={visible} dismiss={dismiss} onHidden={settle} />
      {/* Last, so it sits over every screen and the snackbar alike. */}
      <EnvBadge />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Outfit_400Regular: require('@/assets/fonts/Outfit_400Regular.ttf'),
    Outfit_500Medium: require('@/assets/fonts/Outfit_500Medium.ttf'),
    Outfit_600SemiBold: require('@/assets/fonts/Outfit_600SemiBold.ttf'),
  });
  const [dbReady, setDbReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    initDatabase()
      .then(() => setDbReady(true))
      .catch((error) => console.error('Failed to initialize database', error));
    // Best-effort: must not hold up the first screen, so nothing is awaited.
    enablePushEverywhere().catch((error) => console.error('Failed to register for notifications', error));
    startPushTapRouting();
    getAppSettings()
      .then((loaded) => {
        applyLanguage(loaded.language);
        setSettings(loaded);
      })
      .catch((error) => console.error('Failed to load app settings', error));
  }, []);

  useEffect(() => {
    if (fontsLoaded && dbReady && settings) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, dbReady, settings]);

  // Gated on the database being ready, since every sync pass reads and
  // writes it. Starting before sign-in is fine — see startSyncScheduler.
  useEffect(() => {
    if (!dbReady) return;
    return startSyncScheduler();
  }, [dbReady]);

  // Dev-only: reports how long the JS thread is actually unavailable,
  // which phase timers can't (they measure wall time, so waiting and
  // blocking look the same).
  useEffect(() => startJankMonitor(), []);

  if (!fontsLoaded || !dbReady || !settings) {
    return null;
  }

  return (
    <AppSettingsProvider initialSettings={settings}>
      <AppShell />
    </AppSettingsProvider>
  );
}
