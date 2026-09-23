#!/usr/bin/env node
/**
 * Merges the `push` section of each locale JSON into the per-locale files
 * app.json's `locales` field points Expo at: an `ios.Localizable.strings`
 * block (SDK 55+'s own mechanism for this — see docs/guides/localization)
 * and an `android` flat map shaped like strings.xml, both of which the
 * relay's loc-key/loc-args notification resolves against natively, no app
 * code involved. Run after any change to push text;
 * push-copy-parity.test.ts fails until it has been.
 *
 * channelGroup/invitesChannel stay out of both: those are Android channel
 * names read by i18next at JS runtime (services/channels.ts), never
 * through a native loc-key lookup on either platform.
 */
const fs = require('fs');
const path = require('path');

const LANGUAGES = ['en', 'tr', 'es', 'fr', 'de'];
const NOT_NATIVE = new Set(['channelGroup', 'invitesChannel']);

const app = path.join(__dirname, '..');
const sourceLocales = path.join(app, 'src/core/i18n/locales');
const configLocales = path.join(app, 'locales');

/**
 * i18next's named placeholders, as each platform's own positional format
 * specifier: actor is always arg 1, circle always arg 2 (compose.go's own
 * convention) — a string that only needs one just never sees the other's
 * specifier.
 */
function asIOSFormat(text) {
  return text.replace('{{actor}}', '%1$@').replace('{{circle}}', '%2$@');
}
function asAndroidFormat(text) {
  return text.replace('{{actor}}', '%1$s').replace('{{circle}}', '%2$s');
}

/**
 * aapt2 rejects a "." in a string resource's name, so the dotted keys
 * compose.go names (matching iOS's own Localizable.strings convention)
 * lose the dots here — mirrors internal/push/fcm/sender.go's
 * androidResourceName, which the relay applies to the same keys at send
 * time. iOS keeps the dots; only Android has this restriction.
 */
function androidKey(key) {
  return key.replace(/\./g, '_');
}

for (const language of LANGUAGES) {
  const push = JSON.parse(fs.readFileSync(path.join(sourceLocales, `${language}.json`), 'utf8')).push;
  const keys = Object.keys(push)
    .filter((key) => !NOT_NATIVE.has(key))
    .sort();

  const iosStrings = {};
  const android = {};
  for (const key of keys) {
    iosStrings[`push.${key}`] = asIOSFormat(push[key]);
    android[androidKey(`push.${key}`)] = asAndroidFormat(push[key]);
  }

  const configPath = path.join(configLocales, `${language}.json`);
  // tr/es/fr/de already carry unrelated ios.* entries (permission
  // descriptions); merge rather than overwrite so this stays their only
  // other consumer's business, not this script's.
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const merged = {
    ...existing,
    ios: { ...existing.ios, 'Localizable.strings': iosStrings },
    android: { ...existing.android, ...android },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(iosStrings).length} push strings to ${path.relative(app, configPath)}`);
}
