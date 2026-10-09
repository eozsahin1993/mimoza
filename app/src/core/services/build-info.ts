import * as Application from 'expo-application';
import Constants from 'expo-constants';

/** Set by app.config.js; absent in tests and in a bare `expo start`. */
type Extra = { appEnv?: string; jsBuild?: unknown };

const extra = Constants.expoConfig?.extra as Extra | undefined;

/** From app.json's "version" — Constants.expoConfig is only ever missing in a context this never runs in. */
export const appVersion = Constants.expoConfig?.version ?? 'Unknown';

/** Which environment this build talks to; undefined outside a real build. */
export const appEnvironment = extra?.appEnv;

/**
 * What someone is actually running, as two numbers they can read out: the
 * build that shipped the native app, and the CI run that published the
 * JavaScript on top of it. They differ once an update lands, which is the
 * only way to tell an updated app from a fresh install of the same build.
 *
 * The build number comes from the binary rather than the config — after an
 * update the config is the one the update was exported with. An update is
 * fetched on one launch and run on the next, so the second number changes
 * only after the app is fully quit and reopened, not merely foregrounded.
 *
 * Null where there is no binary to ask, which is only tests.
 */
export function buildNumbers(): string | null {
  const native = Application.nativeBuildVersion;
  const js = typeof extra?.jsBuild === 'string' ? extra.jsBuild : null;
  if (!native) return null;
  return js && js !== native ? `${native}.${js}` : native;
}
