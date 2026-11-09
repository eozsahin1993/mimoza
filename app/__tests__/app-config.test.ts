import { readFileSync } from 'fs';
import path from 'path';

import type { ConfigContext, ExpoConfig } from 'expo/config';

import appConfig from '../app.config';
import { withoutStagingPrefix } from '@/core/services/deep-links';

const APP_JSON = JSON.parse(readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')).expo as Partial<ExpoConfig>;
const AASA_PATH = path.join(__dirname, '..', '..', 'landing', 'public', '.well-known', 'apple-app-site-association');

// Set on process.env itself, never by replacing it: under jest,
// babel-preset-expo turns process.env.EXPO_PUBLIC_* into a read from
// expo/virtual/env, which holds on to the original object.
function resolve(appEnv: string): ExpoConfig {
  const vars: Record<string, string> = {
    APP_ENV: appEnv,
    EAS_PROJECT_ID: 'test-project',
    EXPO_PUBLIC_RELAY_URL: 'https://api.example.com',
  };
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    const context: ConfigContext = {
      config: structuredClone(APP_JSON),
      projectRoot: path.join(__dirname, '..'),
      staticConfigPath: null,
      packageJsonPath: null,
    };
    return appConfig(context);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function invitePath(config: ExpoConfig): string {
  return String(config.extra?.inviteLinkBase).replace(/^https:\/\/[^/]+/, '');
}

describe('invite links in the app config', () => {
  test('production opens /join/ on joinmimoza.com', () => {
    const config = resolve('production');

    expect(config.ios?.associatedDomains).toEqual(['applinks:joinmimoza.com']);
    expect(config.android?.intentFilters).toEqual([
      expect.objectContaining({
        autoVerify: true,
        data: [{ scheme: 'https', host: 'joinmimoza.com', pathPrefix: '/join/' }],
      }),
    ]);
    expect(config.extra?.inviteLinkBase).toBe('https://joinmimoza.com/join/');
  });

  test('staging opens /staging/join/ on the same host', () => {
    const config = resolve('staging');

    expect(config.ios?.associatedDomains).toEqual(['applinks:joinmimoza.com']);
    expect(config.android?.intentFilters).toEqual([
      expect.objectContaining({
        autoVerify: true,
        data: [{ scheme: 'https', host: 'joinmimoza.com', pathPrefix: '/staging/join/' }],
      }),
    ]);
    expect(config.extra?.inviteLinkBase).toBe('https://joinmimoza.com/staging/join/');
  });

  test('dev claims no links, so its invites stay on the custom scheme', () => {
    const config = resolve('dev');

    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
    expect(config.extra?.inviteLinkBase).toBeUndefined();
  });

  test('a staging invite routes to the same screen as a production one', () => {
    const staging = `${resolve('staging').extra?.inviteLinkBase}abc123`;
    const production = `${resolve('production').extra?.inviteLinkBase}abc123`;

    expect(withoutStagingPrefix(staging)).toBe(production);
  });
});

// iOS only opens a link in the app if the site's file names that exact app
// for that path, so a renamed bundle id or path on either side breaks
// invites without any error.
describe("the website's iOS verification file", () => {
  const details = JSON.parse(readFileSync(AASA_PATH, 'utf8')).applinks.details as {
    appIDs: string[];
    components: { '/': string }[];
  }[];

  test.each(['production', 'staging'])('lets the %s app open its own invite path', (appEnv) => {
    const config = resolve(appEnv);
    const appId = `${config.ios?.appleTeamId}.${config.ios?.bundleIdentifier}`;

    expect(details.find((entry) => entry.appIDs.includes(appId))?.components).toEqual([{ '/': `${invitePath(config)}*` }]);
  });
});
