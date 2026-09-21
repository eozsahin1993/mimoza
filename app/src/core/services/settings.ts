import AsyncStorage from '@react-native-async-storage/async-storage';

import { isLanguageCode, type LanguagePreference } from '@/core/i18n/languages';

export type ThemePreference = 'system' | 'light' | 'dark';

export type AppSettings = {
  themePreference: ThemePreference;
  /** Which level a newly created or joined circle starts at — see push-preferences.ts. */
  defaultPushLevel: string;
  language: LanguagePreference;
  /** Whether the home screen's notification ask has had its answer — either one. It isn't shown again. */
  notificationPromptAnswered: boolean;
  /**
   * Which invite pushes this phone takes, as a mask of InvitePushCategories
   * bits: someone asking to join through a link it made, and an answer to a
   * request it sent. Per phone, since it only decides this device's rows.
   */
  invitePushMask: number;
};

const STORAGE_KEY = 'app_settings';

const DEFAULT_SETTINGS: AppSettings = {
  themePreference: 'system',
  // Reactions used to be where the volume jumped — one photo could draw
  // five pushes, none saying anything a comment didn't. notify-circle.ts
  // now scopes a reaction push to the post's own author, and only on their
  // first reaction to it, so that volume concern is gone.
  defaultPushLevel: 'reactions',
  language: 'system',
  notificationPromptAnswered: false,
  // Both, spelled out rather than imported: this module stays free of
  // feature code. InvitePushCategories' ALL_INVITE_PUSH is the same value.
  invitePushMask: 0b11,
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
