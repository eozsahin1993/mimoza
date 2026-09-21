const GOOGLE_SIGN_IN = '@react-native-google-signin/google-signin';

/**
 * Derives Google Sign-In's iOS URL scheme from the same client ID the app
 * passes to GoogleSignin.configure(), so the two can't drift. The SDK refuses
 * to sign in when the scheme isn't that ID reversed.
 */
function iosUrlScheme() {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const suffix = '.apps.googleusercontent.com';
  if (!clientId?.endsWith(suffix)) return undefined;
  return `com.googleusercontent.apps.${clientId.slice(0, -suffix.length)}`;
}

/**
 * Staging is a separate app, not a flag inside one: its own bundle id,
 * name, scheme and App Group, so both can be installed side by side.
 *
 * The App Group is the part that matters most. It backs the shared
 * Keychain (keystore.ts) and the notification extension's snapshot
 * (push-snapshot.ts), so one group across both apps would mean staging
 * reading prod's master seed and circles.
 *
 * APNs topics are bundle ids, and Google/Apple OAuth clients are tied to
 * them too, so an environment's relay config has to match this — see
 * server/.env.example and docs/INFRASTRUCTURE.md.
 */
const ENVIRONMENTS = {
  dev: {
    googleServicesFile: './google-services.dev.json'
  },
  production: {
    channel: 'production', 
    googleServicesFile: './google-services.prod.json' 
  },
  staging: {
    channel: 'staging',
    googleServicesFile: './google-services.staging.json',
    nameSuffix: ' Staging',
    idSuffix: '.staging',
    scheme: 'mimoza-staging',
    icon: './assets/images/icon-staging.png',
    androidForeground: './assets/images/android-icon-foreground-staging.png',
  },
};

module.exports = ({ config }) => {
  const name = process.env.APP_ENV || 'dev';
  const env = ENVIRONMENTS[name];
  if (!env) {
    throw new Error(`APP_ENV=${name} is not an environment (${Object.keys(ENVIRONMENTS).join(', ')})`);
  }
  requireEnvironment(name, env);

  config = { ...config, android: { ...config.android, googleServicesFile: env.googleServicesFile } };

  if (!env.idSuffix) return withBuildNumber(withGoogleScheme(withEnv(withPushEnvironment(config), name, env)));

  const bundleIdentifier = `${config.ios.bundleIdentifier}${env.idSuffix}`;
  const appGroup = `group.${bundleIdentifier}`;

  return withBuildNumber(withGoogleScheme(withEnv({
    ...withPushEnvironment(config),
    name: `${config.name}${env.nameSuffix}`,
    scheme: env.scheme,
    icon: env.icon ?? config.icon,
    ios: {
      ...config.ios,
      icon: env.icon ?? config.ios.icon,
      bundleIdentifier,
      entitlements: {
        ...config.ios.entitlements,
        'com.apple.security.application-groups': [appGroup],
      },
    },
    android: {
      ...config.android,
      adaptiveIcon: {
        ...config.android.adaptiveIcon,
        foregroundImage: env.androidForeground ?? config.android.adaptiveIcon.foregroundImage,
      },
      package: `${config.android.package}${env.idSuffix}`,
    },
  }, name, env)));
};

/**
 * A build number that can't repeat or be forgotten: CI passes its run
 * number, which only ever goes up. app.json's value is the local
 * fallback — every upload burns a number permanently, so two builds from
 * one commit still need two.
 */
function withBuildNumber(config) {
  const build = process.env.APP_BUILD_NUMBER;
  if (!build) return config;
  return {
    ...config,
    ios: { ...config.ios, buildNumber: String(build) },
    android: { ...config.android, versionCode: Number(build) },
  };
}

/**
 * Refuses to build an environment against the wrong relay.
 *
 * EXPO_PUBLIC_* values are inlined by Metro, so a bundler started without
 * the environment's own file quietly compiles in dev's relay — producing
 * a staging app, with staging's bundle id, talking to localhost. The
 * relay then rejects every token for an audience it doesn't expect, which
 * reads like a sign-in bug rather than a build one.
 */
function requireEnvironment(name, env) {
  if (!env.idSuffix) return;

  const relay = process.env.EXPO_PUBLIC_RELAY_URL;
  if (!relay) {
    throw new Error(`APP_ENV=${name} needs EXPO_PUBLIC_RELAY_URL — run \`npm run start:${name}\` (or ios:${name}), which loads .env.${name}.`);
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(relay)) {
    throw new Error(`APP_ENV=${name} is pointed at ${relay}. A bundler started without .env.${name} inlines the local relay; stop it and run \`npm run start:${name}\`.`);
  }
}

// Readable at runtime through Constants.expoConfig.extra, so the app can
// say which environment it is — see ui/components/env-badge.tsx. A build
// that reaches the wrong relay is otherwise indistinguishable on screen.
/**
 * Which APNs environment the build registers against.
 *
 * `development` is the sandbox: a build carrying it gets a sandbox device
 * token, and a push sent to production APNs for that token is rejected as
 * unregistered. TestFlight and the App Store both run against production,
 * so a distributed build carrying `development` takes every notification
 * silently — it registers, the relay accepts the token, and nothing ever
 * arrives.
 *
 * Keyed on how the build is signed, not on APP_ENV: only a distribution
 * profile carries the production entitlement, so a locally-run production
 * build has to register against the sandbox or it won't sign at all.
 * Named for the relay's own APNS_PRODUCTION, which has to agree with it.
 */
function withPushEnvironment(config) {
  const production = process.env.APNS_PRODUCTION === 'true';
  return {
    ...config,
    ios: {
      ...config.ios,
      entitlements: {
        ...config.ios.entitlements,
        'aps-environment': production ? 'production' : 'development',
      },
    },
  };
}

/**
 * The EAS project id and owning account come from the environment rather
 * than app.json: the repo is public, and neither is worth handing over
 * for free. Both ship inside the binary anyway, so this is tidiness
 * rather than secrecy — an update url is public by design.
 */
function withEnv(config, name, env) {
  const projectId = process.env.EAS_PROJECT_ID;
  return {
    ...config,
    owner: process.env.EAS_PROJECT_OWNER ?? config.owner,
    extra: {
      ...config.extra,
      appEnv: name,
      // Which CI run produced this JavaScript. Captured when the bundle is
      // exported, so an update carries the run that published it while the
      // binary carries the run that built it — the two differ once an
      // update lands, which is the point.
      jsBuild: process.env.GITHUB_RUN_NUMBER ?? null,
      ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}),
    },
    ...(projectId && env.channel
      ? {
          updates: {
            ...config.updates,
            url: `https://u.expo.dev/${projectId}`,
            requestHeaders: { 'expo-channel-name': env.channel },
          },
        }
      : {}),
  };
}

/**
 * Dropped rather than left unconfigured when there is no client id: the
 * plugin throws on a missing iosUrlScheme, and every tool that reads this
 * config — eas, expo install, gradle — evaluates it without an env file
 * and would fail on a project it never intended to build.
 *
 * A build that actually needs Google sign-in has the id, because
 * requireEnvironment refuses to build staging or production without one.
 */
function withGoogleScheme(config) {
  const scheme = iosUrlScheme();
  return {
    ...config,
    plugins: config.plugins.flatMap((plugin) => {
      if (plugin !== GOOGLE_SIGN_IN) return [plugin];
      return scheme ? [[GOOGLE_SIGN_IN, { iosUrlScheme: scheme }]] : [];
    }),
  };
}
