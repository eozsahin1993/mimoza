import { Buffer } from 'buffer';

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { decrypt, encryptJSON, generateEphemeralKeypair, generateUUID, hashBytes, openSealedBox, verify } from '@/core/crypto/primitives';
import { buildAuthorityKeyClaim, deriveAuthorityKeypair, deriveCircleIdentity, derivePushRoutingId, deriveCircleSealingKeypair } from '@/core/crypto/identity';
import { deriveInvitePreviewKey, deriveInviteTag, deriveJoinRequestKey } from '@/features/invite/crypto';
import {
  deletePendingJoinRequest,
  getAllPendingJoinRequests,
  getPendingJoinRequest,
  getProfile,
  insertCircle,
  recordMemberAddedLocally,
  insertPendingJoinRequest,
  MemberRoles,
  type PendingJoinRequest,
} from '@/data/db';
import type { InvitePreviewPayload, JoinApprovalEnvelope, JoinRequestPayload } from '@/features/invite/usecases/invite-payloads';
import { writeCoverFile } from '@/core/photo/photo-cache';
import { defaultCircleMask } from '@/features/push-notifications/usecases/push-preferences';
import { ensureCircleNotificationChannel } from '@/features/push-notifications/services/channels';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { recordInManifestBestEffort } from '@/features/account/usecases/account-manifest';
import { compressToThumbnail } from '@/core/photo/image';
import { saveCircleIdentity, saveCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { deletePendingJoinKeypair, getPendingJoinKeypair, savePendingJoinKeypair } from '@/features/invite/keystore';
import { deleteJoinRequest, getJoinRequestApproval, putJoinRequest } from '@/core/services/mailbox-relay';
import { JoinRequestGoneError } from '@/core/services/relay-errors';
import { getInvitePreview } from '@/features/invite/services/invite-preview-relay';
import { getBlob } from '@/core/services/blob-relay';
import { notifyInviteCreator, registerPushForPendingRequest } from '@/features/invite/usecases/invite-push';
import { refreshPushSnapshot } from '@/features/push-notifications/usecases/push-snapshot';

/**
 * Fetches the circle's cover straight from its fixed `cover` key, so a
 * joiner sees it before the first meta pull rather than a few seconds
 * after. It decrypts with the current key, which is wrong if the cover
 * predates a rotation — that fails authentication and lands here, and the
 * pull fixes it once `cover_photo_set` arrives with the right version.
 * Best-effort throughout: a missing or tampered object never fails a join.
 */
async function fetchCoverPhoto(syncId: string, contentKey: Uint8Array): Promise<Uint8Array | null> {
  try {
    const encrypted = await getBlob(syncId, 'cover');
    return encrypted ? decrypt(encrypted, contentKey) : null;
  } catch (err) {
    console.error('Failed to fetch cover photo while joining', err);
    return null;
  }
}

/**
 * Fetches and decrypts an invite's preview — "You're about to join: X" —
 * without submitting a request. Throws if the invite doesn't exist (bad
 * code, or the invite's expired and been evicted server-side).
 */
export async function previewInvite(inviteCode: string): Promise<InvitePreviewPayload> {
  const blob = await getInvitePreview(deriveInviteTag(inviteCode));
  if (!blob) throw new Error('This invite is invalid or has expired.');

  const key = deriveInvitePreviewKey(inviteCode);
  return JSON.parse(new TextDecoder().decode(decrypt(blob, key))) as InvitePreviewPayload;
}

/**
 * Submits a join request against an invite code: generates a one-time
 * keypair for this handshake (see `openSealedBox`'s doc comment),
 * publishes the request to the mailbox, and records it locally so a
 * "pending for Family Circle" screen survives the app being closed and
 * reopened before approval ever lands.
 */
export async function requestToJoin(inviteCode: string): Promise<{ requestId: string }> {
  // Asking twice for the same key is the same ask. Without this, reopening
  // an invite link stacks a second request — its own keypair, its own
  // mailbox row, its own waiting row — and the admin sees a queue of
  // identical strangers to judge.
  const existing = await findPendingJoinRequestForInvite(inviteCode);
  if (existing) return { requestId: existing.id };

  const preview = await previewInvite(inviteCode);

  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed yet — onboarding must generate one before joining any circle.');

  const requestId = generateUUID();
  const keypair = generateEphemeralKeypair();
  const profile = await getProfile();

  // The circle identity is derived here rather than at completion because
  // its *public* halves have to travel in this request: only an admin may
  // write `member_added`, so the approver names this member, and can't do
  // that without their keys.
  // Nothing shared is needed to derive them — circleId is a local id this
  // device invents, and the secret in the derivation is the seed. It's
  // parked on the pending row because the same id must be reused at
  // completion, or the identity would be orphaned.
  const circleId = generateUUID();
  const identity = deriveCircleIdentity(masterSeed, circleId);
  const sealingKeypair = deriveCircleSealingKeypair(masterSeed, circleId);

  // Best-effort — a thumbnail failure shouldn't block submitting the
  // request itself; the approval screen just falls back to a placeholder.
  let pictureThumbnail: string | undefined;
  if (profile?.picture) {
    try {
      pictureThumbnail = Buffer.from(await compressToThumbnail(profile.picture)).toString('base64');
    } catch (err) {
      console.error('Failed to compress profile picture for join request', err);
    }
  }

  // Claimed before the request shares it with every holder of the code
  // (see invite-push.ts). It's the future circle's own routing id, so joining
  // later just re-locks it.
  const pushRoutingId = derivePushRoutingId(masterSeed, circleId);
  // Best-effort: a request that can't register push still goes out, and
  // polling finds the answer. It still has to carry the routing id, which
  // the approver needs for the roster.
  const pushRegistered = await registerPushForPendingRequest(pushRoutingId, inviteCode).then(
    () => true,
    (err) => {
      console.error('Failed to register push for a join request', err);
      return false;
    },
  );

  const request: JoinRequestPayload = {
    pushRoutingId,
    ...buildAuthorityKeyClaim(masterSeed, circleId, bytesToHex(identity.publicKey)),
    ephemeralPublicKey: bytesToHex(keypair.publicKey),
    identityPublicKey: bytesToHex(identity.publicKey),
    encPublicKey: bytesToHex(sealingKeypair.publicKey),
    selfReportedName: profile?.name ?? '',
    pictureThumbnail,
  };
  const key = deriveJoinRequestKey(inviteCode);
  await putJoinRequest(deriveInviteTag(inviteCode), requestId, encryptJSON(request, key));
  // Optional in the preview type; every invite this app creates has one.
  if (preview.pushRoutingId) {
    notifyInviteCreator(preview.pushRoutingId, inviteCode, requestId, request.selfReportedName).catch((err) =>
      console.error('Failed to notify the invite creator', err),
    );
  }

  await savePendingJoinKeypair(requestId, keypair);
  await insertPendingJoinRequest({
    id: requestId,
    circleId,
    inviteCode,
    circleName: preview.name,
    createdByName: preview.createdByName,
    createdByPublicKey: preview.createdByPublicKey,
    ephemeralPublicKey: bytesToHex(keypair.publicKey),
    submittedAt: Date.now(),
    status: 'pending',
    pushRoutingId: pushRegistered ? pushRoutingId : null,
  });
  // The iOS extension reads the request from the snapshot to verify its approval push.
  void refreshPushSnapshot();

  return { requestId };
}

/**
 * Finishes a join once the approval's been decrypted: mirrors
 * `createCircle`'s order of operations (key map + identity to Keychain
 * before any local DB writes), roster role `member` not `admin`.
 *
 * `keyMap` is the approver's *entire* version→key map, not just the
 * current version — lets this device decrypt history predating its own
 * join. Its own `member_added` entry uses the current (highest) version,
 * same as any post would.
 *
 * Adopts the `circleId` minted back at `requestToJoin` rather than
 * generating a fresh one — the identity whose public halves the approver
 * already wrote into `member_added` was derived from that id, so a new
 * one here would silently orphan it.
 *
 * This device does *not* announce itself: `member_added` may only be
 * written by an admin, so the approver wrote it, and this device meets
 * its own entry when it walks
 * meta from epoch 0 — where it lands as a no-op against the row inserted
 * here. The local insert exists only so the joiner sees themselves
 * immediately, without waiting for a sync pass.
 *
 * That row has a consequence worth knowing before touching the roster
 * rules: a joiner's roster is therefore *never empty* on its first meta
 * walk. `member_added`'s bootstrap exemption has to be phrased as "no
 * admin exists yet", not "no members exist yet" — phrased the second way
 * it never fires here, the founder's entry is rejected for lacking a
 * voucher that only that same entry could install, and the joiner ends up
 * with an empty feed and a roster of one. See entry-handlers/member-added.ts.
 */
async function completeJoin(pending: PendingJoinRequest, keyMap: Record<number, Uint8Array>, syncId: string, circleName: string): Promise<{ circleId: string }> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed yet — onboarding must generate one before joining any circle.');

  const currentVersion = Math.max(...Object.keys(keyMap).map(Number));
  const currentKey = keyMap[currentVersion];

  const now = Date.now();
  const pushCategoryMask = await defaultCircleMask();
  const { circleId } = pending;
  const memberId = generateUUID();
  const identity = deriveCircleIdentity(masterSeed, circleId);
  const sealingKeypair = deriveCircleSealingKeypair(masterSeed, circleId);

  await saveCircleKeyMap(circleId, keyMap);
  await saveCircleIdentity(circleId, { ...identity, memberId });

  const picture = await fetchCoverPhoto(syncId, currentKey);
  const pictureHash = picture ? hashBytes(picture) : null;
  if (picture && pictureHash) writeCoverFile(circleId, picture, pictureHash);
  await insertCircle({
    id: circleId,
    name: circleName,
    picture,
    pictureHash,
    syncId,
    pushCategoryMask,
    createdAt: now,
    leftAt: null,
    metaCursor: 0,
    contentCursor: 0,
    lastViewedAt: now,
  });

  const profile = await getProfile();
  const identityPublicKey = bytesToHex(identity.publicKey);
  const encPublicKey = bytesToHex(sealingKeypair.publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: identityPublicKey,
    joinedAt: now,
    profile: {
      encPublicKey,
      memberId,
      pushRoutingId: derivePushRoutingId(masterSeed, circleId),
      authorityPublicKey: bytesToHex(deriveAuthorityKeypair(masterSeed, circleId).publicKey),
      role: MemberRoles.member,
      name: profile?.name ?? '',
      picture: profile?.picture ?? null,
    },
  });

  await ensureCircleNotificationChannel(circleId, circleName);

  await recordInManifestBestEffort();

  await deletePendingJoinKeypair(pending.id);
  await deletePendingJoinRequest(pending.id);

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));

  return { circleId };
}

export type PendingJoinCheck =
  | { joined: true; circleId: string }
  | { joined: false }
  /** The request is over and was not accepted — denied, or aged out. */
  | { joined: false; gone: true };

/**
 * Checks whether a pending join request has been approved yet — polled,
 * and deliberately never dependent on push firing: notifications can be
 * disabled or never delivered, and approval still has to be discoverable.
 * Returns `{joined: false}` while pending, or once the join has
 * completed, the new circle's id.
 *
 * A signature failure is treated the same as no approval yet, not a
 * fatal error — it's the actual gate deciding this came from the
 * invite's real creator (anyone with the invite code could otherwise
 * forge one) — and the pending row is left in place so a later,
 * legitimate approval can still land.
 */
export async function checkPendingJoinRequest(requestId: string): Promise<PendingJoinCheck> {
  const pending = await getPendingJoinRequest(requestId);
  if (!pending) return { joined: false };

  let approval: Uint8Array | null;
  try {
    approval = await getJoinRequestApproval(deriveInviteTag(pending.inviteCode), requestId);
  } catch (err) {
    if (!(err instanceof JoinRequestGoneError)) throw err;
    // Nothing will ever answer this one, so stop asking. Left in place it
    // polls and fails forever, and the person waiting is never told they
    // were declined.
    await deletePendingJoinKeypair(requestId);
    await deletePendingJoinRequest(requestId);
    return { joined: false, gone: true };
  }
  if (!approval) return { joined: false };

  const keypair = await getPendingJoinKeypair(requestId);
  if (!keypair) return { joined: false };

  const envelope = JSON.parse(new TextDecoder().decode(openSealedBox(approval, keypair))) as JoinApprovalEnvelope;
  const approvalBytes = new TextEncoder().encode(JSON.stringify(envelope.approval));
  const signedByCreator = verify(hexToBytes(envelope.signature), approvalBytes, hexToBytes(pending.createdByPublicKey));
  if (!signedByCreator) {
    console.error('A join approval failed signature verification — ignoring it as untrusted.');
    return { joined: false };
  }

  const keyMap = Object.fromEntries(Object.entries(envelope.approval.keyMap).map(([version, hex]) => [Number(version), hexToBytes(hex)]));
  const { circleId } = await completeJoin(pending, keyMap, envelope.approval.syncId, envelope.approval.circleName);
  return { joined: true, circleId };
}

/**
 * Withdraws a join request this device made.
 *
 * The mailbox row goes first so the admin stops seeing a request nobody
 * is waiting on — the relay gates that on nothing but the invite tag and
 * requester id, both of which the requester has. It's best-effort:
 * failing to reach the relay shouldn't leave someone stuck watching a
 * screen they asked to leave, and an unreachable row ages out on the
 * invite's own retention.
 *
 * Local state goes either way, keypair included. Without the keypair an
 * approval that lands afterwards can't be opened, which is the point —
 * cancelling means cancelling, not pausing.
 */
export async function cancelPendingJoinRequest(requestId: string): Promise<void> {
  const pending = await getPendingJoinRequest(requestId);
  if (!pending) return;

  await deleteJoinRequest(deriveInviteTag(pending.inviteCode), requestId).catch((err) =>
    console.error(`Withdrew join request ${requestId} locally, but the relay still holds it`, err)
  );

  await deletePendingJoinKeypair(requestId);
  await deletePendingJoinRequest(requestId);
}

/** The request already outstanding for an invite code, if this device made one. */
export async function findPendingJoinRequestForInvite(inviteCode: string): Promise<PendingJoinRequest | null> {
  const requests = await getAllPendingJoinRequests();
  return requests.find((request) => request.inviteCode === inviteCode) ?? null;
}
