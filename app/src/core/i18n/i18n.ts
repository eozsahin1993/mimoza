// Hermes has no Intl.PluralRules, and i18next picks `_one`/`_other` with
// it — without this every count reads as singular. A no-op where it exists.
import '@formatjs/intl-pluralrules/polyfill.js';
import '@formatjs/intl-pluralrules/locale-data/en.js';
import '@formatjs/intl-pluralrules/locale-data/tr.js';
import '@formatjs/intl-pluralrules/locale-data/es.js';
import '@formatjs/intl-pluralrules/locale-data/fr.js';
import '@formatjs/intl-pluralrules/locale-data/de.js';

import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import de from '@/core/i18n/locales/de.json';
import en from '@/core/i18n/locales/en.json';
import es from '@/core/i18n/locales/es.json';
import fr from '@/core/i18n/locales/fr.json';
import tr from '@/core/i18n/locales/tr.json';
import {
  FALLBACK_LANGUAGE,
  resolveLanguage,
  type LanguageCode,
  type LanguagePreference,
} from '@/core/i18n/languages';
import { getAppSettings } from '@/core/services/settings';

// Synchronous, at import: the first render and the headless push task both
// need `t` working before anything could await it.
// eslint-disable-next-line import/no-named-as-default-member
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    tr: { translation: tr },
    es: { translation: es },
    fr: { translation: fr },
    de: { translation: de },
  },
  lng: FALLBACK_LANGUAGE,
  fallbackLng: FALLBACK_LANGUAGE,
  initAsync: false,
  interpolation: { escapeValue: false },
});

export { i18n };

/** Switches the app to a stored preference, resolving 'system' against the device. */
export function applyLanguage(preference: LanguagePreference, deviceLocales = getLocales()): LanguageCode {
  const language = resolveLanguage(preference, deviceLocales);
  // eslint-disable-next-line import/no-named-as-default-member
  if (i18n.language !== language) void i18n.changeLanguage(language);
  return language;
}

/** For code that runs with no screen mounted — the push task — where nothing else has applied the setting yet. */
export async function loadLanguage(): Promise<LanguageCode> {
  return applyLanguage((await getAppSettings()).language);
}

/** The language the app is showing right now. */
export function currentLanguage(): LanguageCode {
  return i18n.language as LanguageCode;
}
