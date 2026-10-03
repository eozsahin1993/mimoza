import { JoinRequestGoneError } from '@/core/services/relay-errors';
import { dropRequest, getCircle, getRequest, listRequests as listLocalRequests, upsertRequest } from '@/data/db';
import { listCircles as listOnRelay } from '@/features/circle/services/circle-relay';
import {
  cancelRequest as cancelOnRelay,
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
  if (circle && circle.leftAt === null) {
    await dropRequest(circleId);
    return { state: 'approved', circleId };
  }

  const request = await getRequest(circleId);
  if (!request) return { state: 'gone' };
  return request.status === 'pending' ? { state: 'pending' } : { state: 'gone' };
}

/**
 * Withdraws the ask on the relay, then forgets it here, in that order:
 * the relay keeps an ask listed until it is answered or expires, so
 * dropping it only locally would put it back on the next sync and leave
 * an admin able to approve it. The id comes from the relay's own list,
 * since this device never stored it. An ask no longer open there has
 * nothing left to withdraw.
 */
export async function cancelPendingJoinRequest(circleId: string): Promise<void> {
  const { requests } = await listOnRelay();
  const ask = requests.find((request) => request.circleId === circleId);
  if (ask?.status === 'pending') {
    if (!ask.requestId) throw new Error('The relay did not name this ask, so it cannot be withdrawn.');
    await cancelOnRelay(circleId, ask.requestId).catch((err: unknown) => {
      if (!(err instanceof JoinRequestGoneError)) throw err;
    });
  }
  await dropRequest(circleId);
}

export async function findPendingJoinRequestForInvite(code: string) {
  return (await listLocalRequests()).find((request) => request.inviteCode === code) ?? null;
}
