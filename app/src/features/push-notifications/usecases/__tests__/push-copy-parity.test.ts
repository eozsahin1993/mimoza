import { readFileSync } from 'fs';
import { join } from 'path';

import { Languages } from '@/core/i18n/languages';
import de from '@/core/i18n/locales/de.json';
import en from '@/core/i18n/locales/en.json';
import es from '@/core/i18n/locales/es.json';
import fr from '@/core/i18n/locales/fr.json';
import tr from '@/core/i18n/locales/tr.json';

/**
 * The notification copy exists twice — the `push` section of the locale
 * JSON, and the per-locale ios.Localizable.strings/android blocks
 * app.json's `locales` field points Expo at, which `npm run i18n:push`
 * writes from it. Nothing but this test fails when the two drift.
 */

type LocaleConfig = { ios?: { 'Localizable.strings'?: Record<string, string> }; android?: Record<string, string> };

const configs: Record<string, LocaleConfig> = Object.fromEntries(
  Languages.map(({ code }) => [code, JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'locales', `${code}.json`), 'utf8'))]),
);

/** Channel names, read by i18next at JS runtime (services/channels.ts) — never through a native loc-key lookup. Mirrors the script. */
const NOT_NATIVE = new Set(['channelGroup', 'invitesChannel']);

const translations = { en, tr, es, fr, de };

/** i18next's named placeholders, as each platform's own positional format specifier. Mirrors the script. */
function asIOSFormat(text: string): string {
  return text.replace('{{actor}}', '%1$@').replace('{{circle}}', '%2$@');
}
function asAndroidFormat(text: string): string {
  return text.replace('{{actor}}', '%1$s').replace('{{circle}}', '%2$s');
}

/** aapt2 rejects a "." in a resource name. Mirrors the script and internal/push/fcm/sender.go's androidResourceName. */
function androidKey(key: string): string {
  return key.replace(/\./g, '_');
}

test.each(Languages.map((language) => [language.code]))('%s: ios and android carry exactly the JSON push keys', (code) => {
  const push = translations[code as keyof typeof translations].push as Record<string, string>;
  const keys = Object.keys(push).filter((key) => !NOT_NATIVE.has(key));

  const ios = configs[code].ios?.['Localizable.strings'] ?? {};
  const android = configs[code].android ?? {};

  expect(Object.keys(ios).sort()).toEqual(keys.map((key) => `push.${key}`).sort());
  expect(Object.keys(android).sort()).toEqual(keys.map((key) => androidKey(`push.${key}`)).sort());
});

test.each(Languages.map((language) => [language.code]))('%s: every string matches the JSON (run npm run i18n:push if not)', (code) => {
  const push = translations[code as keyof typeof translations].push as Record<string, string>;
  const ios = configs[code].ios?.['Localizable.strings'] ?? {};
  const android = configs[code].android ?? {};

  for (const key of Object.keys(push).filter((candidate) => !NOT_NATIVE.has(candidate))) {
    expect([key, ios[`push.${key}`]]).toEqual([key, asIOSFormat(push[key])]);
    expect([key, android[androidKey(`push.${key}`)]]).toEqual([key, asAndroidFormat(push[key])]);
  }
});
