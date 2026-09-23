import { authorizedFetch, describeError } from '@/core/services/relay';

/**
 * The circles themselves: what this account is in, who is in them, and
 * the keys sealed to it. Entries and the writes that change them are
 * post-relay's.
 */

/**
 * How one circle looks to one member. Not a thing the relay stores: the
 * circle's shared half (name, cover, key and roster versions) joined
 * with this account's own member row (role, notify level, rewrap).
 *
 * So two members hold the same circle differently, and none of this is
 * state to compare against another member's. The row in data/db is this
 * plus the cursors and view state that never leave the device.
 */
export type Circle = {
  circleId: string;
  name: string;
  coverId?: string;
  /** Which content key the cover is sealed under — absent exactly when coverId is. */
  coverKeyVersion?: number;
  role: string;
  notifyLevel: string;
  keyVersion: number;
  rosterVersion: number;
  lastEntryAt?: number;
  needsRewrap?: boolean;
};

export type PendingRequest = {
  circleId: string;
  circleName?: string;
  status: string;
  createdAt: number;
};

export type RosterMember = {
  accountId: string;
  name?: string;
  avatarId?: string;
  avatarKeyVersion?: number;
  publicKey?: string;
  role: string;
  notifyLevel: string;
  needsRewrap?: boolean;
  joinedAt: number;
};

export type Roster = {
  rosterVersion: number;
  keyVersion: number;
  members: RosterMember[];
  /** This account's own sealed keys, by version. Nobody else's are ever returned. */
  keys: Record<string, string>;
};

/** Where a sync starts: every circle this account is in, and every ask it is waiting on. */
export async function listCircles(): Promise<{ circles: Circle[]; requests: PendingRequest[] }> {
  const response = await authorizedFetch('/v1/circles');
  if (!response.ok) throw new Error(await describeError(response, 'listing circles'));
  const body = (await response.json()) as { circles?: Circle[]; requests?: PendingRequest[] };
  return { circles: body.circles ?? [], requests: body.requests ?? [] };
}

/**
 * The founder seals the first content key to their own account key, or
 * they make a circle they cannot read.
 *
 * Answers with the same shape the circle list returns, so the
 * device that made it applies relay state through the path a sync uses
 * rather than guessing at the role and notify level it was given.
 */
export async function createCircle(name: string, sealedKey: string): Promise<Circle> {
  const response = await authorizedFetch('/v1/circles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, sealedKey }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'creating a circle'));
  return (await response.json()) as Circle;
}

/**
 * The roster and this account's own sealed keys: one call, because a
 * device that has learned the roster moved almost always needs both.
 */
export async function getRoster(circleId: string): Promise<Roster> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/roster`);
  if (!response.ok) throw new Error(await describeError(response, 'reading the roster'));
  return (await response.json()) as Roster;
}

export async function renameCircle(circleId: string, name: string): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'renaming the circle'));
}

export async function setCover(circleId: string, coverId: string, coverKeyVersion: number): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coverId, coverKeyVersion }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'changing the cover'));
}

/**
 * Field-level rules, enforced by the relay: notifyLevel and avatarId only
 * on your own row, role only by an admin and never on your own.
 */
export async function patchMembership(
  circleId: string,
  accountId: string,
  change: { role?: string; notifyLevel?: string; avatarId?: string; keyVersion?: number }
): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/members/${accountId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  });
  if (!response.ok) throw new Error(await describeError(response, 'changing a membership'));
}

/** Leaving rotates too, so `sealed` is the new key per remaining account id. */
export async function leaveCircle(circleId: string, keyVersion: number, sealed: Record<string, string>): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: keyVersion, sealed }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'leaving the circle'));
}

/**
 * Removing a member rotates the key, so the caller seals the new one to
 * everyone staying. `sealed` is keyed by account id here; on `rewrapKeys`
 * the same field is keyed by version.
 */
export async function removeMember(
  circleId: string,
  accountId: string,
  keyVersion: number,
  sealed: Record<string, string>
): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/members/${accountId}/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: keyVersion, sealed }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'removing a member'));
}

export async function deleteCircle(circleId: string): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await describeError(response, 'deleting the circle'));
}

/** Resealing every version to a member who replaced their keypair: `sealed` keyed by version. */
export async function rewrapKeys(
  circleId: string,
  accountId: string,
  sealed: Record<string, string>
): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, sealed }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'resealing keys'));
}
