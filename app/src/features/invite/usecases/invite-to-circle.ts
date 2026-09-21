import { Buffer } from 'buffer';

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { decrypt, encryptJSON, generateInviteCode, generateUUID, sealToPublicKey, sign } from '@/core/crypto/primitives';
import { deriveInvitePreviewKey, deriveInviteTag, deriveJoinRequestKey } from '@/features/invite/crypto';
import {
  getCircle,
  getCurrentInvite,
  getMemberByPublicKey,
  getProfile,
  insertInvite,
  recordMemberAddedLocally,
  insertOutboxEntry,
  MemberRoles,
  OutboxStatuses,
  revokeInvite,
  type Invite,
} from '@/data/db';
import type { InvitePreviewPayload, JoinApprovalEnvelope, JoinApprovalPayload, JoinRequestPayload } from '@/features/invite/usecases/invite-payloads';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { bytesToDataUri, compressToThumbnail, parsePictureThumbnail } from '@/core/photo/image';
import { pullMeta } from '@/core/sync/pull-log';
import { getCircleIdentity, getCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { deleteJoinRequest, listJoinRequests, putJoinApproval } from '@/core/services/mailbox-relay';
import { createInvitePreview } from '@/features/invite/services/invite-preview-relay';
import { notifyRequester, registerPushForInvite, unregisterPushForInvite } from '@/features/invite/usecases/invite-push';
import { refreshPushSnapshot } from '@/features/push-notifications/usecases/push-snapshot';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolves this device's own public key + roster row for a circle, or null before it has an identity there. */
async function getOwnMember(circleId: string) {
  const identity = await getCircleIdentity(circleId);
  if (!identity) return null;

  const publicKey = bytesToHex(identity.publicKey);
  const member = await getMemberByPublicKey(circleId, publicKey);
  return member ? { publicKey, member } : null;
}

/** Whether this device is an admin of the circle — for screens to decide what to show, not just what to allow. */
export async function isCircleAdmin(circleId: string): Promise<boolean> {
  const own = await getOwnMember(circleId);
  return own?.member.role === MemberRoles.admin;
}

/**
 * Resolves this device's own public key in the circle, and confirms it's
 * an admin. `message` lets callers outside the invite flow (e.g.
 * `remove-member.ts`) surface an error that names their own operation
 * rather than the invite one.
 */
export async function requireAdminPublicKey(circleId: string, message = "Only an admin can manage this circle's invite."): Promise<string> {
  const own = await getOwnMember(circleId);
  if (own?.member.role !== MemberRoles.admin) throw new Error(message);

  return own.publicKey;
}

/**
 * Writes the server-side `sk = "invite"` row — the circle's current name,
 * encrypted under a key derived from the invite code alone, so anyone who
 * taps the link can preview what they're about to join before requesting
 * to. Not best-effort: an invite whose
 * preview never lands is unjoinable, so a failure here should surface the
 * same way any other invite-creation failure does.
 */
async function writeInvitePreview(code: string, circleName: string, createdByPublicKey: string, pushRoutingId: string | null): Promise<void> {
  const profile = await getProfile();
  // Best-effort, like the one on a join request: a thumbnail that won't
  // compress shouldn't stop an invite being created.
  let createdByPicture: string | undefined;
  if (profile?.picture) {
    try {
      createdByPicture = Buffer.from(await compressToThumbnail(profile.picture)).toString('base64');
    } catch (err) {
      console.error('Failed to compress profile picture for invite preview', err);
    }
  }

  const payload: InvitePreviewPayload = { name: circleName, createdByName: profile?.name ?? '', createdByPublicKey, createdByPicture, pushRoutingId: pushRoutingId ?? undefined };
  const key = deriveInvitePreviewKey(code);
  await createInvitePreview(deriveInviteTag(code), encryptJSON(payload, key));
}

async function createInvite(circleId: string, createdByPublicKey: string): Promise<Invite> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('Circle not found.');

  const code = generateInviteCode();
  // Before the preview: that's where the routing id gets shared, and it
  // has to be claimed by then (see invite-push.ts). Claims it even without
  // notification permission; this phone's device joins when that's given.
  // Push is best-effort: if it fails, the link works and just sends none.
  const pushRoutingId = await registerPushForInvite(code).catch((err) => {
    console.error('Failed to register push for a new invite', err);
    return null;
  });

  const now = Date.now();
  const invite: Invite = {
    code,
    circleId,
    createdByPublicKey,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    revokedAt: null,
    pushRoutingId,
  };
  await insertInvite(invite);
  await writeInvitePreview(invite.code, circle.name, createdByPublicKey, pushRoutingId);
  // The iOS extension finds the invite's circle in the snapshot to title its request push.
  if (pushRoutingId) void refreshPushSnapshot();
  return invite;
}

/**
 * Returns the circle's current, live invite — creating one if there isn't
 * one yet, or the existing one has expired. Reused rather than minted
 * fresh on every visit to the invite screen, so the code someone already
 * shared keeps working.
 */
export async function getOrCreateInvite(circleId: string): Promise<Invite> {
  const publicKey = await requireAdminPublicKey(circleId);

  const current = await getCurrentInvite(circleId);
  if (current && current.expiresAt > Date.now()) return current;

  return createInvite(circleId, publicKey);
}

/**
 * Revokes the circle's current invite (if any) and issues a fresh one —
 * kills the old link/code for anyone still holding it, without touching
 * members who already joined through it.
 */
export async function replaceInvite(circleId: string): Promise<Invite> {
  const publicKey = await requireAdminPublicKey(circleId);

  const current = await getCurrentInvite(circleId);
  if (current) {
    await revokeInvite(current.code);
    // Straight away rather than on the next sweep: replacing a link is
    // meant to cut the old one off. A failure leaves it to the sweep.
    await unregisterPushForInvite(current).catch((err) => console.error('Failed to unregister push for the replaced invite', err));
  }

  return createInvite(circleId, publicKey);
}

/**
 * Confirms this device is specifically the invite's *creator*, not just
 * any admin — an admin who didn't create this invite has no more context
 * to judge a request than a stranger would. Client-side only — the relay
 * is blind and can't enforce it.
 */
async function requireInviteCreatorPublicKey(circleId: string): Promise<{ publicKey: string; invite: Invite }> {
  const own = await getOwnMember(circleId);
  const invite = await getCurrentInvite(circleId);
  if (!own || !invite || own.publicKey !== invite.createdByPublicKey) {
    throw new Error("Only this invite's creator can see or approve its join requests.");
  }
  return { publicKey: own.publicKey, invite };
}

export type PendingRequest = {
  requesterId: string;
  /** The key they'll be a member under once let in — seeds their avatar colour so it doesn't change on approval. */
  identityPublicKey: string;
  selfReportedName: string;
  /** Data URI of the requester's self-reported thumbnail, if they sent one — see `compressToThumbnail`. */
  pictureUri?: string;
  createdAt: number;
};

/**
 * Lists join requests still awaiting this device's decision — self-
 * reported name and picture only, not verified identity: as spoofable as
 * anything typed at profile setup, so this is "someone used the invite,"
 * never a confirmed identity. Skips rows that fail to decrypt (e.g.
 * stale, from a previous invite) rather than failing the whole list, and
 * rows already carrying an
 * `encryptedApproval` (approved in place, not deleted, so they'd
 * otherwise keep reappearing here with nothing left to do).
 */
export async function discoverPendingRequests(circleId: string): Promise<PendingRequest[]> {
  const own = await getOwnMember(circleId);
  const invite = await getCurrentInvite(circleId);
  if (!own || !invite || own.publicKey !== invite.createdByPublicKey) return [];

  const key = deriveJoinRequestKey(invite.code);

  const requests = await listJoinRequests(deriveInviteTag(invite.code));
  const pending: PendingRequest[] = [];
  for (const request of requests) {
    if (request.encryptedApproval) continue;
    try {
      const payload = JSON.parse(new TextDecoder().decode(decrypt(request.encryptedRequest, key))) as JoinRequestPayload;
      const picture = parsePictureThumbnail(payload.pictureThumbnail);
      pending.push({
        requesterId: request.requesterId,
        identityPublicKey: payload.identityPublicKey,
        selfReportedName: payload.selfReportedName,
        pictureUri: picture ? bytesToDataUri(picture) : undefined,
        createdAt: request.createdAt,
      });
    } catch (err) {
      console.error('Failed to decrypt a join request', err);
    }
  }
  return pending;
}

/**
 * Dismisses a pending join request without approving it ("not now") —
 * permanently: the request row is deleted server-side, so the requester
 * would need to submit a fresh request (reopen the invite link) to try
 * again. Same creator-only gate as `approveJoinRequest`.
 */
export async function denyJoinRequest(circleId: string, requesterId: string): Promise<void> {
  const { invite } = await requireInviteCreatorPublicKey(circleId);
  await deleteJoinRequest(deriveInviteTag(invite.code), requesterId);
}

/**
 * Approves one pending join request: seals this device's entire
 * version→content-key map (not just the current version — a joiner needs
 * every version to decrypt history predating their join) + circle name
 * to the requester's ephemeral public key.
 *
 * Also signs the approval with this device's circle identity before
 * sealing — without it, any existing member (not just the creator) could
 * forge an equally valid-looking approval, since the creator-only check
 * above is client-side only. The signature is what
 * `checkPendingJoinRequest` actually verifies against.
 */
export async function approveJoinRequest(circleId: string, requesterId: string): Promise<void> {
  const { invite } = await requireInviteCreatorPublicKey(circleId);
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('Circle not found.');

  const inviteTag = deriveInviteTag(invite.code);
  const requests = await listJoinRequests(inviteTag);
  const request = requests.find((r) => r.requesterId === requesterId);
  if (!request) throw new Error('That join request is no longer available.');

  const requestKey = deriveJoinRequestKey(invite.code);
  const { ephemeralPublicKey, identityPublicKey, encPublicKey, pushRoutingId, authorityPublicKey, authorityKeyProof, selfReportedName, pictureThumbnail } =
    JSON.parse(
    new TextDecoder().decode(decrypt(request.encryptedRequest, requestKey))
  ) as JoinRequestPayload;
  // Validated once here, not trusted as-is — a requester's own device is
  // the one that's supposed to have run this through compressToThumbnail,
  // but nothing stops a malicious or buggy client sending something else
  // entirely. Re-encoding from the validated bytes (rather than forwarding
  // the original string) means what actually goes out on the wire is
  // always exactly what was validated, never the untrusted input itself.
  const picture = parsePictureThumbnail(pictureThumbnail);
  const picturePayload = picture ? Buffer.from(picture).toString('base64') : undefined;

  // Catch up on meta before sealing: a stale approver would otherwise hand
  // over an incomplete key map, and the joiner would be unable to read
  // history it should have.
  await pullMeta(circleId);

  const keyMap = await getCircleKeyMap(circleId);
  if (!keyMap) throw new Error('No content key on this device.');
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');

  const hexKeyMap = Object.fromEntries(Object.entries(keyMap).map(([version, key]) => [version, bytesToHex(key)]));
  const approval: JoinApprovalPayload = { keyMap: hexKeyMap, syncId: circle.syncId, circleName: circle.name };
  const signature = sign(new TextEncoder().encode(JSON.stringify(approval)), identity.secretKey);
  const envelope: JoinApprovalEnvelope = { approval, signature: bytesToHex(signature) };

  const sealed = sealToPublicKey(new TextEncoder().encode(JSON.stringify(envelope)), hexToBytes(ephemeralPublicKey));
  await putJoinApproval(inviteTag, requesterId, sealed);
  // The payload type allows none; every request this app sends has one.
  if (pushRoutingId) {
    notifyRequester(pushRoutingId, invite.code, sealed).catch((err) => console.error('Failed to notify the requester', err));
  }

  // Only an admin may write `member_added`, so it is written here, by
  // the approver, rather than self-announced by the joiner — an entry
  // signed by someone no device
  // has yet heard of is discarded by every honest client. This is what
  // makes the new member visible to everyone else: the joiner supplied
  // the public halves, and this signature is the circle vouching for them.
  const currentVersion = Math.max(...Object.keys(keyMap).map(Number));
  // Carried on the entry so every device dates this join the same way —
  // a device replaying meta from epoch 0 would otherwise stamp it with
  // its own "now" and sort it to the top of the feed.
  const joinedAt = Date.now();
  const memberAddedEntry = buildAndEncryptLogEntry(
    EntryTypes.MEMBER_ADDED,
    {
      identityPublicKey,
      encPublicKey,
      name: selfReportedName,
      role: MemberRoles.member,
      keyVersion: currentVersion,
      picture: picturePayload,
      createdAt: joinedAt,
      // Copied from the request, not derived: only the joiner's own seed
      // produces either of these.
      pushRoutingId,
      // Forwarded untouched, proof and all: this entry is signed by the
      // approver, so only the proof makes the key believable.
      authorityPublicKey,
      authorityKeyProof,
    },
    identity,
    keyMap[currentVersion]
  );
  await insertOutboxEntry({
    circleId,
    entryType: EntryTypes.MEMBER_ADDED,
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    blobEntryId: null,
    encryptedMeta: memberAddedEntry,
  });

  // Applied locally too, so the approver's own roster updates immediately
  // instead of only when its next pass walks this entry back. Idempotent
  // against that later echo.
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: identityPublicKey,
    joinedAt,
    profile: {
      encPublicKey,
      memberId: generateUUID(),
      pushRoutingId,
      authorityPublicKey,
      role: MemberRoles.member,
      name: selfReportedName,
      picture: picture ?? null,
    },
  });

  drainOutbox(circleId).catch((err) => console.error('Failed to push member_added', err));
}
