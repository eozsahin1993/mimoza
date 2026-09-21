import { Buffer } from 'buffer';

import { authorizedFetch, baseUrl } from '@/core/services/relay';

/**
 * The relay's push routing endpoints.
 *
 * Registration is session-gated like everything else. `sendPush` is not,
 * and deliberately: an authenticated send would arrive beside an
 * identified poster, letting the relay solve a circle's membership by
 * elimination. It authorizes on the fanout token instead.
 *
 * Every write carries the owner token (`derivePushOwnerToken`) in a header:
 * the routing id is known to the whole circle, so it can't authorize a
 * change on its own.
 */

function ownerHeader(ownerToken: Uint8Array): Record<string, string> {
  return { 'Push-Owner': Buffer.from(ownerToken).toString('base64') };
}

/** Writes this account's control row for one circle — categories and the fanout hash. */
export async function putPushPrefs(
  pushRoutingId: string,
  pushFanoutHash: Uint8Array,
  categories: number[],
  keyVersion: number,
  ownerToken: Uint8Array,
): Promise<void> {
  const response = await authorizedFetch(`/v1/push/${pushRoutingId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...ownerHeader(ownerToken) },
    body: JSON.stringify({
      pushFanoutHash: Buffer.from(pushFanoutHash).toString('base64'),
      categories,
      keyVersion,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to store push preferences: ${response.status}`);
  }
}

/** Registers this device's push token under a routing id. */
export async function putPushDevice(
  pushRoutingId: string,
  deviceId: string,
  pushToken: string,
  platform: 'ios' | 'android',
  enabled: boolean,
  ownerToken: Uint8Array,
): Promise<void> {
  const response = await authorizedFetch(`/v1/push/${pushRoutingId}/devices/${deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...ownerHeader(ownerToken) },
    body: JSON.stringify({ pushToken: Buffer.from(pushToken, 'utf8').toString('base64'), platform, enabled }),
  });
  if (!response.ok) {
    throw new Error(`Failed to register push device: ${response.status}`);
  }
}

/** Removes one device's row. Idempotent. */
export async function deletePushDevice(pushRoutingId: string, deviceId: string, ownerToken: Uint8Array): Promise<void> {
  const response = await authorizedFetch(`/v1/push/${pushRoutingId}/devices/${deviceId}`, {
    method: 'DELETE',
    headers: ownerHeader(ownerToken),
  });
  if (!response.ok) {
    throw new Error(`Failed to remove push device: ${response.status}`);
  }
}

/** Silences a circle outright — prefs and every device row. Idempotent. */
export async function deletePushRouting(pushRoutingId: string, ownerToken: Uint8Array): Promise<void> {
  const response = await authorizedFetch(`/v1/push/${pushRoutingId}`, { method: 'DELETE', headers: ownerHeader(ownerToken) });
  if (!response.ok) {
    throw new Error(`Failed to silence push for this circle: ${response.status}`);
  }
}

export type FanoutResult = { delivered: number; skipped: number };

/**
 * Fans a notification out to a circle. Unauthenticated on purpose — see
 * this file's header. `payload` is the entry's own ciphertext.
 */
export async function sendPush(
  pushRoutingIds: string[],
  pushFanoutToken: Uint8Array,
  category: number,
  keyVersion: number,
  payload: Uint8Array,
): Promise<FanoutResult> {
  const response = await fetch(`${baseUrl()}/v1/push/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pushRoutingIds,
      pushFanoutToken: Buffer.from(pushFanoutToken).toString('base64'),
      category,
      keyVersion,
      payload: Buffer.from(payload).toString('base64'),
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to send push: ${response.status}`);
  }
  return (await response.json()) as FanoutResult;
}
