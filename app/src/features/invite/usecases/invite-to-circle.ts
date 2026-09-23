import { getCircle } from '@/data/db';
import { getCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { fromWire, toWire } from '@/core/crypto/content';
import { sealToPublicKey } from '@/core/crypto/primitives';
import {
  approveRequest,
  createInvite,
  denyRequest,
  listInvites,
  listRequests,
  revokeInvite,
  type Invite,
  type JoinRequest,
} from '@/features/invite/services/invite-relay';

/**
 * The admin side of getting someone in. Nothing here is secret except
 * the seals in `approveJoinRequest`; the relay decides who may do any of
 * it, so the checks below only keep the UI honest.
 */

/** Local, for hiding controls. The relay refuses a non-admin regardless. */
export async function isCircleAdmin(circleId: string): Promise<boolean> {
  return (await getCircle(circleId))?.role === 'admin';
}

/** Any admin sees the same code: it belongs to the circle, not to whoever made it. */
export async function getOrCreateInvite(circleId: string): Promise<Invite> {
  const [existing] = await listInvites(circleId);
  return existing ?? createInvite(circleId);
}

/** Burns the current code and hands back a fresh one, for a link that got out. */
export async function replaceInvite(circleId: string): Promise<Invite> {
  for (const invite of await listInvites(circleId)) {
    await revokeInvite(circleId, invite.code);
  }
  return createInvite(circleId);
}

export async function discoverPendingRequests(circleId: string): Promise<JoinRequest[]> {
  return (await listRequests(circleId)).filter((request) => request.status === 'pending');
}

/**
 * Every version, not just the current one: a joiner missing v1 can see
 * that history exists and not read it, which is why the relay refuses an
 * incomplete set.
 *
 * The joiner is not on the roster yet, so their ask is the only place
 * their key is published — one without it can never be approved.
 */
export async function approveJoinRequest(circleId: string, requestId: string): Promise<void> {
  const request = (await listRequests(circleId)).find((pending) => pending.requestId === requestId);
  if (!request) throw new Error('That ask is no longer waiting.');
  if (!request.publicKey) throw new Error('That ask carries no key to seal to.');

  const keys = await getCircleKeyMap(circleId);
  if (!keys) throw new Error('No content keys on this device for this circle.');

  const publicKey = fromWire(request.publicKey);
  const sealed: Record<string, string> = {};
  for (const [version, key] of Object.entries(keys)) {
    sealed[version] = toWire(sealToPublicKey(key, publicKey));
  }

  await approveRequest(circleId, requestId, sealed);
}

export async function denyJoinRequest(circleId: string, requestId: string): Promise<void> {
  await denyRequest(circleId, requestId);
}
