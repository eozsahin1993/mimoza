import AsyncStorage from '@react-native-async-storage/async-storage';

import { isLanguageCode, type LanguagePreference } from '@/core/i18n/languages';

export type ThemePreference = 'system' | 'light' | 'dark';

export type AppSettings = {
  themePreference: ThemePreference;
  language: LanguagePreference;
  /** Whether the home screen's notification ask has had its answer — either one. It isn't shown again. */
  notificationPromptAnswered: boolean;
};

const STORAGE_KEY = 'app_settings';

const DEFAULT_SETTINGS: AppSettings = {
  themePreference: 'system',
  language: 'system',
  notificationPromptAnswered: false,
};

/**
 * Device-local UI preferences (appearance, notification toggles) — not
 * circle data, so this lives in shared prefs / UserDefaults via
 * AsyncStorage rather than a SQLite table. Nothing here needs to be
 * queried or joined, just read whole and written back whole.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  const settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  // A language dropped in a later release falls back to the device's.
  if (settings.language !== 'system' && !isLanguageCode(settings.language)) settings.language = 'system';
  return settings;
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
  const current = await getAppSettings();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
}
