import { authorizedFetch, describeError } from '@/core/services/relay';

/**
 * The circles themselves: what this account is in, who is in them, and
 * the keys sealed to it. Entries and the writes that change them are
 * post-relay's.
 */

export type Membership = {
  circleId: string;
  name: string;
  coverId?: string;
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
export async function listCircles(): Promise<{ circles: Membership[]; requests: PendingRequest[] }> {
  const response = await authorizedFetch('/v1/circles');
  if (!response.ok) throw new Error(await describeError(response, 'listing circles'));
  const body = (await response.json()) as { circles?: Membership[]; requests?: PendingRequest[] };
  return { circles: body.circles ?? [], requests: body.requests ?? [] };
}

export async function createCircle(name: string, sealedKey: string): Promise<{ circleId: string }> {
  const response = await authorizedFetch('/v1/circles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, sealed: sealedKey }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'creating a circle'));
  return (await response.json()) as { circleId: string };
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

export async function setCover(circleId: string, coverId: string): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coverId }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'changing the cover'));
}

/** Your own notification level, or your own picture for this circle. Never anyone else's. */
export async function patchMembership(
  circleId: string,
  accountId: string,
  change: { notifyLevel?: string; avatarId?: string; keyVersion?: number }
): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/members/${accountId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  });
  if (!response.ok) throw new Error(await describeError(response, 'changing a membership'));
}

export async function leaveCircle(circleId: string, keyVersion: number, sealed: Record<string, string>): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: keyVersion, sealed }),
  });
  if (!response.ok) throw new Error(await describeError(response, 'leaving the circle'));
}

/** Removing a member rotates the key, so the caller seals the new one to everyone staying. */
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

/** Resealing every version to a member who replaced their keypair. */
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
