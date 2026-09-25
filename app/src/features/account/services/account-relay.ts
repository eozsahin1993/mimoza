import { DeviceLinkAnsweredError, DeviceLinkGoneError } from '@/core/services/relay-errors';
import { authorizedFetch, describeError } from '@/core/services/relay';

/**
 * The account itself: the profile every circle shows, and the public key
 * members seal content keys to.
 *
 * A picture is not here. It is circle content, sealed to a circle's key
 * and set on the membership — see circles-relay. Devices are push's, in
 * features/push-notifications.
 */

export type Profile = {
  accountId: string;
  name: string;
  publicKey?: string;
  createdAt: number;
};

export async function getProfile(): Promise<Profile> {
  const response = await authorizedFetch('/v1/account');
  if (!response.ok) throw new Error(await describeError(response, 'reading the profile'));
  return (await response.json()) as Profile;
}

export async function setName(name: string): Promise<Profile> {
  const response = await authorizedFetch('/v1/account/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'saving the profile'));
  return (await response.json()) as Profile;
}

/**
 * Publishes the key members seal to. `reset` says this device has no
 * private key and made a new pair, which makes every sealed copy
 * unreadable until another member reseals them: the circles that are now
 * waiting come back in the answer.
 */
export async function publishPublicKey(
  publicKey: string,
  reset = false
): Promise<{ awaitingRewrap: string[] }> {
  const response = await authorizedFetch('/v1/account/pubkey', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, reset }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'publishing the public key'));
  const body = (await response.json()) as { awaitingRewrap?: string[] };
  return { awaitingRewrap: body.awaitingRewrap ?? [] };
}

/**
 * The last call this account ever makes. The relay erases it from every
 * circle, deletes its own rows, and ends every session, so nothing here
 * needs to walk anything first.
 */
export async function deleteAccount(): Promise<void> {
  const response = await authorizedFetch('/v1/account', { method: 'DELETE' });
  if (!response.ok) throw new Error(await describeError(response, 'deleting the account'));
}

/**
 * Handing this account's keypair from a phone that has it to one that
 * does not. The relay is a dead drop: it holds a throwaway public key it
 * did not choose and a blob sealed to it, and never the private half.
 *
 * Both ends are this same account — the relay keys a session inside the
 * account's own partition, so there is no session id another account
 * could name.
 */

export type DeviceLinkSession = {
  sessionId: string;
  expiresAt: number;
};

export type DeviceLink = {
  sessionId: string;
  publicKey: string;
  /** Absent until the other device answers, which is what polling waits for. */
  sealedKeypair?: string;
  expiresAt: number;
};

/** The waiting device opens a session against a key it just minted. */
export async function createDeviceLink(publicKey: string): Promise<DeviceLinkSession> {
  const response = await authorizedFetch('/v1/account/device-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'opening a device link'));
  return (await response.json()) as DeviceLinkSession;
}

/** The answering device sends the keypair, sealed to the scanned key. */
export async function sendDeviceLinkKeys(sessionId: string, sealedKeypair: string): Promise<void> {
  const response = await authorizedFetch(`/v1/account/device-link/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sealedKeypair }),
  });
  if (response.status === 404) throw new DeviceLinkGoneError();
  if (response.status === 409) throw new DeviceLinkAnsweredError();
  if (!response.ok) throw new Error(await describeError(response, 'sending the keys over'));
}

/** What the waiting device polls. `sealedKeypair` is absent until it lands. */
export async function readDeviceLink(sessionId: string): Promise<DeviceLink> {
  const response = await authorizedFetch(`/v1/account/device-link/${encodeURIComponent(sessionId)}`);
  if (response.status === 404) throw new DeviceLinkGoneError();
  if (!response.ok) throw new Error(await describeError(response, 'checking the device link'));
  return (await response.json()) as DeviceLink;
}
