/**
 * Seeds Android's default (unqualified) values/strings.xml with the push
 * loc keys, from the same English text generate-push-strings.js already
 * wrote to locales/en.json's android map.
 *
 * Expo's own locales plugin (app.json's `locales` field) only ever
 * writes values-b+<lang>/strings.xml — including for "en" — never the
 * default. These keys exist nowhere else native, so without this aapt2
 * drops them for want of a default value, and lint fails every other
 * language's copy as ExtraTranslation. Seeding the default here is what
 * both need.
 *
 * Values go in raw, not pre-wrapped in quotes the way Locales.js wraps
 * its own — setStringItem's {resources: {string: [...]}} shape is what
 * makes @expo/config-plugins' XML writer auto-escape each value's own
 * quotes and apostrophes (see escapeAndroidString in its XML util);
 * Locales.js writes a differently-shaped object that happens to skip
 * that pass, which is why it has to escape its own quoting by hand.
 * Wrapping here too would double-escape into a literal backslash in the
 * shipped notification text.
 */
const fs = require('fs');
const path = require('path');
const { withStringsXml, AndroidConfig } = require('expo/config-plugins');

module.exports = (config) =>
  withStringsXml(config, async (config) => {
    const en = JSON.parse(
      fs.readFileSync(path.join(config.modRequest.projectRoot, 'locales/en.json'), 'utf8'),
    );
    const items = Object.entries(en.android ?? {}).map(([name, value]) => ({ $: { name }, _: value }));
    config.modResults = AndroidConfig.Strings.setStringItem(items, config.modResults);
    return config;
  });
