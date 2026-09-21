import { decrypt, encryptJSON } from '@/core/crypto/primitives';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { getAllPendingJoinRequests, getInvitesWithPushRouting, setInvitePushRoutingId, type Invite } from '@/data/db';
import { getAppSettings } from '@/core/services/settings';
import { deriveInvitePushFanoutToken, deriveJoinRequestKey, derivePushInviteRoutingId } from '@/features/invite/crypto';
import { derivePushFanoutHash } from '@/core/crypto/push';
import { sendPush, type PushKind } from '@/core/services/push-relay';
import { deleteRouting, deleteRoutingDevice, putRoutingDevice, putRoutingPrefs } from '@/core/services/push-routing';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';
import { InvitePushCategories, type InvitePushCategory } from '@/features/push-notifications/usecases/push-categories';

/**
 * The two pushes of the join handshake (docs/INVITE_PUSH.md): a request
 * reaching the invite's creator, and an approval reaching the requester.
 *
 * Neither side can use a circle's push registration — the requester has no
 * content key yet — so both are opened by the invite code instead, the one
 * secret the two sides share. Everything here is best-effort for the
 * handshake: callers go ahead without push when it fails, and polling
 * still completes the join.
 */

/** What a request push carries, encrypted under the join-request key. Not the request itself: that won't fit in 4 KB. */
type JoinRequestPushPayload = { requesterId: string; selfReportedName: string };

/**
 * Registers push that holders of `inviteCode` can send to. Must land
 * before the routing id is shared (preview or request): an unclaimed
 * routing id could otherwise be claimed first by anyone who read it.
 */
async function registerPushForInviteKind(
  pushRoutingId: string,
  inviteCode: string,
  kind: InviteKind,
  category: InvitePushCategory,
): Promise<void> {
  const fanoutHash = derivePushFanoutHash(deriveInvitePushFanoutToken(inviteCode), pushRoutingId);
  await putRoutingPrefs(pushRoutingId, kind, fanoutHash, [category], 0);

  // Without permission, or with this kind switched off on this phone,
  // there's no device to add; the prefs row still claims the routing id.
  if (!(await wantsPush(category))) return;
  // Only the prefs write above has to land. A device that fails to join is
  // re-sent by the launch sweep, and mustn't cost the invite or request.
  try {
    const device = await getDevicePushToken();
    if (device) await putRoutingDevice(pushRoutingId, device);
  } catch (err) {
    console.error(`Failed to add this device to a ${kind} routing`, err);
  }
}

type InviteKind = Extract<PushKind, 'invite' | 'pending_request'>;

/** The category each invite kind takes. */
const CATEGORY: Record<InviteKind, InvitePushCategory> = {
  invite: InvitePushCategories.joinRequest,
  pending_request: InvitePushCategories.joinApproved,
};

/** Whether this phone takes a category (account screen). Per phone, so it decides only this device's row. */
async function wantsPush(category: InvitePushCategory): Promise<boolean> {
  return ((await getAppSettings()).invitePushMask & (1 << category)) !== 0;
}

/** The creator's push for one invite. Returns its routing id, for the preview and the invite row. */
export async function registerPushForInvite(inviteCode: string): Promise<string> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');

  const pushRoutingId = derivePushInviteRoutingId(masterSeed, inviteCode);
  await registerPushForInviteKind(pushRoutingId, inviteCode, 'invite', CATEGORY.invite);
  return pushRoutingId;
}

/**
 * The requester's push while they wait, on the future circle's own
 * routing id, so joining only re-locks it with the content key.
 */
export async function registerPushForPendingRequest(pushRoutingId: string, inviteCode: string): Promise<void> {
  await registerPushForInviteKind(pushRoutingId, inviteCode, 'pending_request', CATEGORY.pending_request);
}

/**
 * Deletes a revoked or expired invite's push registration, then forgets it. The
 * relay would expire it anyway; this makes replacing a link cut the old
 * one off at once. If the delete fails the row keeps the id, and the next
 * sweep retries.
 */
export async function unregisterPushForInvite(invite: Invite): Promise<void> {
  if (!invite.pushRoutingId) return;

  await deleteRouting(invite.pushRoutingId);
  await setInvitePushRoutingId(invite.code, null);
}

/**
 * Launch's pass over invites' push: removes it where the invite is
 * over, and re-sends this device's token for live ones, since a token can
 * rotate. One failing never stops the rest.
 */
export async function sweepInvitePush(): Promise<void> {
  const invites = await getInvitesWithPushRouting();
  if (!invites.length) return;

  const device = (await wantsPush(CATEGORY.invite)) ? await getDevicePushToken() : null;
  const now = Date.now();

  for (const invite of invites) {
    try {
      if (invite.revokedAt !== null || invite.expiresAt <= now) {
        await unregisterPushForInvite(invite);
      } else if (device && invite.pushRoutingId) {
        await putRoutingDevice(invite.pushRoutingId, device);
      }
    } catch (err) {
      console.error(`Failed to tend push for the invite on circle ${invite.circleId}`, err);
    }
  }
}

/**
 * Applies the account screen's invite mask to the routings that already
 * exist; new ones read it as they're registered. A category switched off
 * deletes this phone's device row under that kind's routings; on puts it
 * back. The prefs rows stay: they hold ownership of the routing ids.
 */
export async function applyInvitePushMask(mask: number): Promise<void> {
  const now = Date.now();
  const routingIds: Record<InviteKind, (string | null)[]> = {
    invite: (await getInvitesWithPushRouting())
      .filter((invite) => invite.revokedAt === null && invite.expiresAt > now)
      .map((invite) => invite.pushRoutingId),
    pending_request: (await getAllPendingJoinRequests()).map((request) => request.pushRoutingId),
  };

  const device = mask ? await getDevicePushToken() : null;

  for (const kind of Object.keys(routingIds) as InviteKind[]) {
    const on = (mask & (1 << CATEGORY[kind])) !== 0;
    if (on && !device) continue;
    for (const pushRoutingId of routingIds[kind]) {
      if (!pushRoutingId) continue;
      try {
        if (on && device) await putRoutingDevice(pushRoutingId, device);
        else await deleteRoutingDevice(pushRoutingId);
      } catch (err) {
        console.error(`Failed to apply invite push for one ${kind} routing`, err);
      }
    }
  }
}

/**
 * Unregisters push for every invite of a circle about to be dropped from
 * this phone (left, deleted, removed from). Its invite rows go with it,
 * and they're the only record the sweep has, so this is the last chance;
 * the relay's expiry covers a failure. Best-effort per invite.
 */
export async function unregisterPushForCircleInvites(circleId: string): Promise<void> {
  const invites = (await getInvitesWithPushRouting()).filter((invite) => invite.circleId === circleId);
  for (const invite of invites) {
    await unregisterPushForInvite(invite).catch((err) => console.error(`Failed to unregister push for an invite on circle ${circleId}`, err));
  }
}

/**
 * Removes this phone from every invite and pending-request routing, for
 * signing out. The prefs rows stay with the account; another of its phones
 * may still want them. Best-effort per routing.
 */
export async function unregisterInvitePushDevice(): Promise<void> {
  const routingIds = [
    ...(await getInvitesWithPushRouting()).map((invite) => invite.pushRoutingId),
    ...(await getAllPendingJoinRequests()).map((request) => request.pushRoutingId),
  ];
  for (const pushRoutingId of routingIds) {
    if (!pushRoutingId) continue;
    await deleteRoutingDevice(pushRoutingId).catch((err) => console.error('Failed to remove this device from an invite routing', err));
  }
}

/** Tells the invite's creator someone asked. Best-effort: they'll find it on their feed regardless. */
export async function notifyInviteCreator(
  inviteRoutingId: string,
  inviteCode: string,
  requesterId: string,
  selfReportedName: string,
): Promise<void> {
  const payload: JoinRequestPushPayload = { requesterId, selfReportedName };
  await sendPush(
    [inviteRoutingId],
    deriveInvitePushFanoutToken(inviteCode),
    InvitePushCategories.joinRequest,
    0,
    encryptJSON(payload, deriveJoinRequestKey(inviteCode)),
  );
}

/**
 * Tells the requester there's news. No payload: their phone writes the
 * text from its own pending row, and the text claims nothing, so a push
 * from anyone else holding the code can't announce a false "you're in".
 * Opening the app does the real check.
 */
export async function notifyRequester(requesterRoutingId: string, inviteCode: string): Promise<void> {
  await sendPush([requesterRoutingId], deriveInvitePushFanoutToken(inviteCode), InvitePushCategories.joinApproved, 0, new Uint8Array());
}

/** The requester's self-reported name from a request push, or null if it doesn't open. */
export function readJoinRequestPush(payload: Uint8Array, inviteCode: string): string | null {
  try {
    const decoded = JSON.parse(new TextDecoder().decode(decrypt(payload, deriveJoinRequestKey(inviteCode)))) as Partial<JoinRequestPushPayload>;
    return typeof decoded.selfReportedName === 'string' ? decoded.selfReportedName : null;
  } catch {
    return null;
  }
}
