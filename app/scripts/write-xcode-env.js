// Hands Xcode the environment the npm scripts run under.
//
// Xcode's script phases don't inherit the shell that ran prebuild, and the
// bundling phase re-evaluates app.config.js from scratch. Without these it
// resolves with everything unset — `iosUrlScheme()` returns undefined and
// the Google Sign-In plugin throws `Missing iosUrlScheme`, which only
// happens on Archive, never on `npm run ios:*` where the CLI passes its own
// environment through.
//
// Written after every prebuild because `--clean` deletes ios/ and Expo
// regenerates .xcode.env.local with NODE_BINARY alone.
const fs = require('fs');
const path = require('path');

/** Everything app.config.js reads. A value missing here fails the archive, not the script. */
const KEYS = [
  'APP_ENV',
  'APNS_PRODUCTION',
  'EXPO_PUBLIC_RELAY_URL',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
];

const ios = path.join(__dirname, '..', 'ios');
if (!fs.existsSync(ios)) {
  console.error('No ios/ — run a prebuild first.');
  process.exit(1);
}

// Created when absent rather than required: it comes from the React Native
// template and a clean prebuild doesn't always leave one behind. NODE_BINARY
// isn't set here — .xcode.env resolves it, and this file only overrides.
const file = path.join(ios, '.xcode.env.local');

const MARKER = '# --- written by scripts/write-xcode-env.js';
const existing = fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split(MARKER)[0].trimEnd()
  : '';

const set = KEYS.filter((k) => process.env[k]);
const lines = set.map((k) => `export ${k}=${JSON.stringify(process.env[k])}`);

// .xcode.env falls back to `command -v node`, which finds nothing when the
// build is driven from Xcode.app rather than a shell. Pinning the node
// running this script is the only version known to be right.
if (!/^\s*export NODE_BINARY=/m.test(existing)) {
  lines.unshift(`export NODE_BINARY=${JSON.stringify(process.execPath)}`);
}

fs.writeFileSync(file, `${existing}\n\n${MARKER}\n${lines.join('\n')}\n`);

const missing = KEYS.filter((k) => !process.env[k]);
console.log(`ios/.xcode.env.local: wrote ${set.length} variables${missing.length ? `, missing ${missing.join(', ')}` : ''}`);
