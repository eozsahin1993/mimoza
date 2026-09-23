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
