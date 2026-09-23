import { dropRequest, getCircle, getRequest, listRequests as listLocalRequests, upsertRequest } from '@/data/db';
import {
  previewInvite as previewOnRelay,
  requestToJoin as askOnRelay,
  type InvitePreview,
} from '@/features/invite/services/invite-relay';

/**
 * The joiner's side. No key exchange here at all: the account's key was
 * published at sign-in, the ask carries it, and the approving admin
 * seals every version to it — so this device waits, and its keys arrive
 * on the next sync.
 */

export type { InvitePreview };

/** What a link opens to, before deciding. Readable by any signed-in account. */
export async function previewInvite(code: string): Promise<InvitePreview> {
  return previewOnRelay(code);
}

/** Remembered locally so the pending screen survives a restart. Asking twice replaces the first ask. */
export async function requestToJoin(
  code: string,
  seen: { circleName: string; invitedByName: string }
): Promise<{ circleId: string; requestId: string }> {
  const request = await askOnRelay(code);
  // What the preview already showed, so the waiting screen names the
  // circle straight away rather than after the next sync.
  await upsertRequest({
    circleId: request.circleId,
    inviteCode: code,
    circleName: seen.circleName,
    invitedByName: seen.invitedByName,
    submittedAt: request.createdAt,
    status: request.status,
  });
  return { circleId: request.circleId, requestId: request.requestId };
}

export type PendingJoinCheck =
  | { state: 'pending' }
  | { state: 'approved'; circleId: string }
  | { state: 'gone' };

/**
 * Local, not a poll: `GET /circles` returns both the circles this
 * account is in and the asks it waits on, so a sync already knows. The
 * circle appearing is approval; the ask vanishing without it is a denial
 * or an expiry.
 */
export async function checkPendingJoinRequest(circleId: string): Promise<PendingJoinCheck> {
  const circle = await getCircle(circleId);
  if (circle && circle.leftAt === null) return { state: 'approved', circleId };

  const request = await getRequest(circleId);
  if (!request) return { state: 'gone' };
  return request.status === 'pending' ? { state: 'pending' } : { state: 'gone' };
}

/** Forgets the ask on this device. The relay keeps it until an admin answers or it expires. */
export async function cancelPendingJoinRequest(circleId: string): Promise<void> {
  await dropRequest(circleId);
}

export async function findPendingJoinRequestForInvite(code: string) {
  return (await listLocalRequests()).find((request) => request.inviteCode === code) ?? null;
}
