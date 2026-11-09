import type { ConfigContext, ExpoConfig } from 'expo/config';

const GOOGLE_SIGN_IN = '@react-native-google-signin/google-signin';
const INVITE_HOST = 'joinmimoza.com';

type EnvironmentName = 'dev' | 'production' | 'staging';

type Environment = {
  googleServicesFile: string;
  iosGoogleServicesFile: string;
  /** The update channel. Dev has none and runs without updates. */
  channel?: string;
  /** Where this environment's invite links live on INVITE_HOST. */
  invitePath?: string;
  /** Set for an environment installed beside production as an app of its own. */
  separateApp?: {
    nameSuffix: string;
    idSuffix: string;
    scheme: string;
    icon: string;
    androidForeground: string;
  };
};

type Context = { name: EnvironmentName; env: Environment };

/** Every step takes the same arguments, so the pipeline below is only an order. */
type Step = (config: ExpoConfig, context: Context) => ExpoConfig;

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
const ENVIRONMENTS: Record<EnvironmentName, Environment> = {
  dev: {
    googleServicesFile: './google-services.dev.json',
    iosGoogleServicesFile: './GoogleService-Info.dev.plist',
  },
  production: {
    channel: 'production',
    googleServicesFile: './google-services.prod.json',
    iosGoogleServicesFile: './GoogleService-Info.prod.plist',
    invitePath: '/join/',
  },
  staging: {
    channel: 'staging',
    googleServicesFile: './google-services.staging.json',
    iosGoogleServicesFile: './GoogleService-Info.staging.plist',
    invitePath: '/staging/join/',
    separateApp: {
      nameSuffix: ' Staging',
      idSuffix: '.staging',
      scheme: 'mimoza-staging',
      icon: './assets/images/icon-staging.png',
      androidForeground: './assets/images/android-icon-foreground-staging.png',
    },
  },
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const name = process.env.APP_ENV || 'dev';
  if (!isEnvironmentName(name)) {
    throw new Error(`APP_ENV=${name} is not an environment (${Object.keys(ENVIRONMENTS).join(', ')})`);
  }
  const context: Context = { name, env: ENVIRONMENTS[name] };
  requireEnvironment(context);

  const steps: Step[] = [
    withServicesFiles,
    withPushEnvironment,
    withSeparateApp,
    withEnv,
    withGoogleScheme,
    withInviteLinks,
    withBuildNumber,
  ];
  return steps.reduce((current, step) => step(current, context), fromAppJson(config));
};

function isEnvironmentName(name: string): name is EnvironmentName {
  return Object.hasOwn(ENVIRONMENTS, name);
}

/** The fields ExpoConfig can't do without come from app.json; a missing one is a broken checkout. */
function fromAppJson(config: Partial<ExpoConfig>): ExpoConfig {
  if (!config.name || !config.slug) throw new Error('app.json must set expo.name and expo.slug');
  return { ...config, name: config.name, slug: config.slug };
}

const withServicesFiles: Step = (config, { env }) => ({
  ...config,
  android: { ...config.android, googleServicesFile: env.googleServicesFile },
  ios: { ...config.ios, googleServicesFile: env.iosGoogleServicesFile },
});

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
const withPushEnvironment: Step = (config) => ({
  ...config,
  ios: {
    ...config.ios,
    entitlements: {
      ...config.ios?.entitlements,
      'aps-environment': process.env.APNS_PRODUCTION === 'true' ? 'production' : 'development',
    },
  },
});

/**
 * Staging's own name, scheme, icon and ids. Spreads the config it is given,
 * never the original: building `ios` from the original once dropped the
 * entitlements withPushEnvironment had set, and every staging and
 * production build registered against the sandbox APNs.
 */
const withSeparateApp: Step = (config, { env }) => {
  const app = env.separateApp;
  if (!app) return config;
  return {
    ...config,
    name: `${config.name}${app.nameSuffix}`,
    scheme: app.scheme,
    icon: app.icon,
    ios: {
      ...config.ios,
      icon: app.icon,
      bundleIdentifier: `${config.ios?.bundleIdentifier}${app.idSuffix}`,
    },
    android: {
      ...config.android,
      adaptiveIcon: { ...config.android?.adaptiveIcon, foregroundImage: app.androidForeground },
      package: `${config.android?.package}${app.idSuffix}`,
    },
  };
};

/**
 * The EAS project id and owning account come from the environment rather
 * than app.json: the repo is public, and neither is worth handing over
 * for free. Both ship inside the binary anyway, so this is tidiness
 * rather than secrecy — an update url is public by design.
 *
 * `appEnv` is readable at runtime through Constants.expoConfig.extra, so
 * the app can say which environment it is (ui/components/env-badge.tsx):
 * a build that reaches the wrong relay is otherwise indistinguishable.
 */
const withEnv: Step = (config, { name, env }) => {
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
};

/**
 * Dropped rather than left unconfigured when there is no client id: the
 * plugin throws on a missing iosUrlScheme, and every tool that reads this
 * config — eas, expo install, gradle — evaluates it without an env file
 * and would fail on a project it never intended to build.
 *
 * A build that actually needs Google sign-in has the id, because
 * requireEnvironment refuses to build staging or production without one.
 */
const withGoogleScheme: Step = (config) => {
  const scheme = iosUrlScheme();
  return {
    ...config,
    plugins: config.plugins?.flatMap((plugin): NonNullable<ExpoConfig['plugins']> => {
      if (plugin !== GOOGLE_SIGN_IN) return [plugin];
      return scheme ? [[GOOGLE_SIGN_IN, { iosUrlScheme: scheme }]] : [];
    }),
  };
};

/**
 * Invite links are https because chat apps only make http(s) tappable:
 * WhatsApp shows a mimoza:// link as plain text. Staging and production
 * share the host and differ by path, and the site's verification files
 * (landing/public/.well-known) say which app opens which, so a phone with
 * both installed still opens the right one. Dev keeps its custom scheme.
 */
const withInviteLinks: Step = (config, { env }) => {
  if (!env.invitePath) return config;
  return {
    ...config,
    ios: { ...config.ios, associatedDomains: [`applinks:${INVITE_HOST}`] },
    android: {
      ...config.android,
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [{ scheme: 'https', host: INVITE_HOST, pathPrefix: env.invitePath }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    extra: { ...config.extra, inviteLinkBase: `https://${INVITE_HOST}${env.invitePath}` },
  };
};

/**
 * A build number that can't repeat or be forgotten: CI passes its run
 * number, which only ever goes up. app.json's value is the local
 * fallback — every upload burns a number permanently, so two builds from
 * one commit still need two.
 */
const withBuildNumber: Step = (config) => {
  const build = process.env.APP_BUILD_NUMBER;
  if (!build) return config;
  return {
    ...config,
    ios: { ...config.ios, buildNumber: String(build) },
    android: { ...config.android, versionCode: Number(build) },
  };
};

/**
 * Derives Google Sign-In's iOS URL scheme from the same client ID the app
 * passes to GoogleSignin.configure(), so the two can't drift. The SDK refuses
 * to sign in when the scheme isn't that ID reversed.
 */
function iosUrlScheme(): string | undefined {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const suffix = '.apps.googleusercontent.com';
  if (!clientId?.endsWith(suffix)) return undefined;
  return `com.googleusercontent.apps.${clientId.slice(0, -suffix.length)}`;
}

/**
 * Refuses to build an environment against the wrong relay.
 *
 * EXPO_PUBLIC_* values are inlined by Metro, so a bundler started without
 * the environment's own file quietly compiles in dev's relay — producing
 * a staging app, with staging's bundle id, talking to localhost. The
 * relay then rejects every token for an audience it doesn't expect, which
 * reads like a sign-in bug rather than a build one.
 *
 * Likewise no EAS_PROJECT_ID: the update url is simply left out, and the
 * binary builds fine with expo-updates off, never checking its channel.
 */
function requireEnvironment({ name, env }: Context): void {
  if (env.channel && !process.env.EAS_PROJECT_ID) {
    throw new Error(`APP_ENV=${name} needs EAS_PROJECT_ID, or the build ships without an update url and never receives updates.`);
  }
  if (!env.separateApp) return;

  const relay = process.env.EXPO_PUBLIC_RELAY_URL;
  if (!relay) {
    throw new Error(`APP_ENV=${name} needs EXPO_PUBLIC_RELAY_URL — run \`npm run start:${name}\` (or ios:${name}), which loads .env.${name}.`);
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(relay)) {
    throw new Error(`APP_ENV=${name} is pointed at ${relay}. A bundler started without .env.${name} inlines the local relay; stop it and run \`npm run start:${name}\`.`);
  }
}
