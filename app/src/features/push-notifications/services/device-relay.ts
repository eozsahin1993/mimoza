import { authorizedFetch, describeError } from '@/core/services/relay';

/**
 * The phones this account is signed in on. Push reaches these and
 * nothing else, so registering one is what turns notifications on for
 * this phone and deleting it is what signing out does.
 */

/** Sent on every launch, not once: a push token rotates on its own schedule. */
export async function registerDevice(
  deviceId: string,
  device: { pushToken: string; platform: 'ios' | 'android'; locale?: string }
): Promise<void> {
  const response = await authorizedFetch(`/v1/account/devices/${deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(device),
  });
  if (!response.ok) throw new Error(await describeError(response, 'registering this device'));
}

/** Signing out: push stops reaching this phone, and nothing else changes. */
export async function unregisterDevice(deviceId: string): Promise<void> {
  const response = await authorizedFetch(`/v1/account/devices/${deviceId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await describeError(response, 'unregistering this device'));
}

