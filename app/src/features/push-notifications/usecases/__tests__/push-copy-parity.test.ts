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
 * JSON, which handle-push.ts composes from on Android, and the iOS
 * extension's string catalog, which `npm run i18n:ios` writes from it.
 * Nothing but this test fails when the two drift. Swift never runs under
 * jest, so this reads the catalog and the extension's source as text.
 */

const extension = join(__dirname, '..', '..', '..', '..', '..', 'targets', 'MimozaNotificationService');
const catalog = JSON.parse(readFileSync(join(extension, 'Localizable.xcstrings'), 'utf8')) as {
  strings: Record<string, { localizations: Record<string, { stringUnit: { value: string } }> }>;
};
const swift = readFileSync(join(extension, 'NotificationService.swift'), 'utf8');

/** Android names its notification channels and their group; iOS has neither. Mirrors the script. */
const ANDROID_ONLY = new Set(['channelGroup', 'invitesChannel']);

const translations = { en, tr, es, fr, de };

/** i18next's named placeholders, as the positional ones Swift's String(format:) takes. */
function asFormat(text: string): string {
  return text.replace('{{name}}', '%1$@').replace('{{text}}', '%2$@').replace('{{emoji}}', '%2$@');
}

test('the catalog has exactly the push keys the JSON has', () => {
  const keys = Object.keys(en.push).filter((key) => !ANDROID_ONLY.has(key));

  expect(Object.keys(catalog.strings).sort()).toEqual(keys.map((key) => `push.${key}`).sort());
});

test.each(Languages.map((language) => [language.code]))('every %s string matches the JSON (run npm run i18n:ios if not)', (code) => {
  const push = translations[code as keyof typeof translations].push as Record<string, string>;
  for (const key of Object.keys(push).filter((candidate) => !ANDROID_ONLY.has(candidate))) {
    expect([key, catalog.strings[`push.${key}`]?.localizations[code]?.stringUnit.value]).toEqual([
      key,
      asFormat(push[key]),
    ]);
  }
});

test('every key the extension looks up is in the catalog', () => {
  const used = [...swift.matchAll(/strings\("(push\.\w+)"/g)].map((match) => match[1]);

  expect(used.length).toBeGreaterThan(0);
  for (const key of used) expect(catalog.strings).toHaveProperty([key]);
});
