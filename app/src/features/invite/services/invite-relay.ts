import { authorizedFetch, describeError } from '@/core/services/relay';
import { JoinRequestGoneError } from '@/core/services/relay-errors';

/**
 * Getting into a circle: the codes an admin hands out, and the asks that
 * come back through them.
 *
 * Nothing here is encrypted. The relay owns membership, so a code is a
 * code and an ask is an ask; the only secret in the flow is the content
 * key an approver seals to the joiner's published account key.
 */

export type Invite = {
  code: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
};

/** What someone sees before deciding to ask. No key material: they are not in yet. */
export type InvitePreview = {
  circleId: string;
  name: string;
  memberCount: number;
  invitedBy: string;
};

export type JoinRequest = {
  requestId: string;
  circleId: string;
  accountId: string;
  name?: string;
  /**
   * What an approver seals every content key version to. The requester
   * is not on the roster yet, so this ask is the only place their key
   * is published.
   */
  publicKey?: string;
  status: string;
  createdAt: number;
};

export async function createInvite(circleId: string): Promise<Invite> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/invites`, { method: 'POST' });
  if (!response.ok) throw new Error(await describeError(response, 'making an invite'));
  return (await response.json()) as Invite;
}

/** Live codes, for any admin — not just whoever made them. */
export async function listInvites(circleId: string): Promise<Invite[]> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/invites`);
  if (!response.ok) throw new Error(await describeError(response, 'listing invites'));
  return ((await response.json()) as { invites?: Invite[] }).invites ?? [];
}

export async function revokeInvite(circleId: string, code: string): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/invites/${code}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await describeError(response, 'revoking an invite'));
}

/** Readable by any signed-in account: it is what a link opens to. */
export async function previewInvite(code: string): Promise<InvitePreview> {
  const response = await authorizedFetch(`/v1/invites/${code}`);
  if (!response.ok) throw new Error(await describeError(response, 'reading an invite'));
  return (await response.json()) as InvitePreview;
}

/** No body: the key an approver seals to is the one this account published at sign-in. */
export async function requestToJoin(code: string): Promise<JoinRequest> {
  const response = await authorizedFetch(`/v1/invites/${code}/requests`, { method: 'POST' });
  if (!response.ok) throw new Error(await describeError(response, 'asking to join'));
  return (await response.json()) as JoinRequest;
}

export async function listRequests(circleId: string): Promise<JoinRequest[]> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/requests`);
  if (!response.ok) throw new Error(await describeError(response, 'listing asks to join'));
  return ((await response.json()) as { requests?: JoinRequest[] }).requests ?? [];
}

/** Every version, keyed by version: a joiner who is missing one cannot read that stretch of history. */
export async function approveRequest(
  circleId: string,
  requestId: string,
  sealed: Record<string, string>
): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/requests/${requestId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sealed }),
  });
  if (response.status === 404) throw new JoinRequestGoneError();
  if (!response.ok) throw new Error(await describeError(response, 'approving an ask'));
}

export async function denyRequest(circleId: string, requestId: string): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/requests/${requestId}/deny`, { method: 'POST' });
  if (response.status === 404) throw new JoinRequestGoneError();
  if (!response.ok) throw new Error(await describeError(response, 'declining an ask'));
}
