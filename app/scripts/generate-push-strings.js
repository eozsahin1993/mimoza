#!/usr/bin/env node
/**
 * Writes the iOS notification extension's Localizable.xcstrings from the
 * `push` section of each locale JSON. The extension can't read the app's
 * JSON, so this copy has to exist; run after any change to push text.
 * push-copy-parity.test.ts fails until it has been.
 */
const fs = require('fs');
const path = require('path');

const LANGUAGES = ['en', 'tr', 'es', 'fr', 'de'];
/** Android names its notification channel group; iOS has no such thing. */
const ANDROID_ONLY = new Set(['channelGroup', 'invitesChannel']);

const app = path.join(__dirname, '..');
const locales = path.join(app, 'src/core/i18n/locales');
const catalog = path.join(app, 'targets/MimozaNotificationService/Localizable.xcstrings');

/** i18next's named placeholders, as the positional ones Swift's String(format:) takes. */
function asFormat(text) {
  return text.replace('{{name}}', '%1$@').replace('{{text}}', '%2$@').replace('{{emoji}}', '%2$@');
}

const push = Object.fromEntries(
  LANGUAGES.map((language) => [language, JSON.parse(fs.readFileSync(path.join(locales, `${language}.json`), 'utf8')).push]),
);

const strings = {};
for (const key of Object.keys(push.en).filter((candidate) => !ANDROID_ONLY.has(candidate)).sort()) {
  strings[`push.${key}`] = {
    extractionState: 'manual',
    localizations: Object.fromEntries(
      LANGUAGES.map((language) => [language, { stringUnit: { state: 'translated', value: asFormat(push[language][key]) } }]),
    ),
  };
}

fs.writeFileSync(catalog, `${JSON.stringify({ sourceLanguage: 'en', strings, version: '1.0' }, null, 2)}\n`);
console.log(`Wrote ${Object.keys(strings).length} strings to ${path.relative(app, catalog)}`);
