import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { NativeModules, Platform } from 'react-native';

import { getAuthToken } from '@/core/services/keystore/auth-token';
import { NetworkUnreachableError, SessionExpiredError } from '@/core/services/relay-errors';
import { noteSessionExpired } from '@/core/services/session';

/**
 * Where the relay is and how to reach it with a session attached. The
 * endpoints themselves live beside what they serve: log-relay.ts,
 * blob-relay.ts, and the per-feature `*-relay.ts` modules, all of which
 * build on `authorizedFetch`/`baseUrl` from here. Raw key/token/signature
 * material is always accepted as `Uint8Array` and hex-encoded at the wire
 * boundary in those modules — callers never hand-encode. Named errors
 * those modules throw live in `relay-errors.ts`, not here or beside each
 * endpoint.
 */

const DEV_RELAY_PORT = process.env.EXPO_PUBLIC_RELAY_PORT ?? '8090';

/**
 * The dev machine's address, from whichever dev-only source reports it:
 * `hostUri` is the documented one but is undefined on some dev clients,
 * and `scriptURL` is where the bundle itself came from. Reading
 * `SourceCode` throws where the module isn't registered. Null in a
 * release build, which has no dev server to ask.
 */
function devHost(): string | null {
  try {
    const scriptUrl = NativeModules.SourceCode?.getConstants?.()?.scriptURL as string | undefined;
    return Constants.expoConfig?.hostUri?.split(':')[0] ?? scriptUrl?.match(/^https?:\/\/([^/:]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Unset counts: both mean "wherever this machine is". */
function isLoopback(url: string | undefined): boolean {
  return !url || /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(url);
}

/** Logged once per address: "could not connect" is unreadable without knowing what was dialled. */
let announced: string | null = null;

/**
 * `EXPO_PUBLIC_RELAY_URL` when it is set, else the dev machine on
 * `EXPO_PUBLIC_RELAY_PORT` while a packager is serving.
 *
 * A configured address wins even in a dev build — a staging build is
 * still a dev build, and must not quietly reach localhost.
 *
 * Loopback is the exception: on a phone it means the phone. There the dev
 * server's address is inferred, which also survives a new DHCP lease —
 * the port is configuration, the address isn't.
 *
 * The Android emulator can't reach the host as `localhost` (that resolves
 * to the emulator); 10.0.2.2 is its alias for the host's loopback. Never
 * applied on a real phone, where 10.0.2.2 is unroutable and every call
 * would hang ~20s before the kernel gave up.
 */
export function baseUrl(): string {
  const host = __DEV__ && isLoopback(process.env.EXPO_PUBLIC_RELAY_URL) ? devHost() : null;
  const configured = host ? `http://${host}:${DEV_RELAY_PORT}` : process.env.EXPO_PUBLIC_RELAY_URL;
  if (!configured) throw new Error('EXPO_PUBLIC_RELAY_URL is not set.');

  const url =
    Platform.OS === 'android' && !Device.isDevice
      ? configured.replace('//localhost', '//10.0.2.2').replace('//127.0.0.1', '//10.0.2.2')
      : configured;

  if (__DEV__ && url !== announced) {
    announced = url;
    console.log(`Relay: ${url}`);
  }
  return url;
}

/**
 * Reads a failed response's body so callers see the relay's actual reason,
 * not just a bare status code — httputil.WriteError's shape is
 * `{"error": "..."}`, so that string is pulled out and appended when
 * present; otherwise falls back to whatever raw text came back.
 */
export async function describeError(response: Response, summary: string): Promise<string> {
  const text = await response.text().catch(() => '');
  let detail = text;
  try {
    const body = JSON.parse(text);
    if (typeof body?.error === 'string' && body.error) detail = body.error;
  } catch {
    // not JSON — use the raw text as-is
  }
  return detail ? `${summary}: ${response.status} ${detail}` : `${summary}: ${response.status}`;
}

/**
 * fetch with the stored session token attached — every circle-log route
 * requires one (server's auth.RequireSession).
 *
 * A 401 is handled here rather than left to callers: the relay only ever
 * means one thing by it (`RequireSession` answers missing, invalid and
 * expired alike), most callers are background sync passes with no way to
 * ask anyone to sign in, and a token the relay has stopped accepting is
 * worth nothing to whoever asks next. The sign-in routes don't come
 * through here, so their own 401 can't be mistaken for this one.
 */
export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  if (!token) {
    throw new Error('Not signed in.');
  }
  // fetch rejects rather than answering when the request never left the
  // device. Named here, once, so no caller has to sniff a message.
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new NetworkUnreachableError();
  }
  if (response.status === 401) {
    await noteSessionExpired();
    throw new SessionExpiredError();
  }
  return response;
}
