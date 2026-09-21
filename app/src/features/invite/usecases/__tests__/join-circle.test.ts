jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/mailbox-relay');
jest.mock('@/features/invite/services/invite-preview-relay');
jest.mock('@/core/photo/image');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/blob-relay');

import { Buffer } from 'buffer';

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { getCircle, getCircleMembers, getPendingJoinRequest, initDatabase, saveProfile } from '@/data/db';
import { getPendingJoinKeypair } from '@/features/invite/keystore';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { approveJoinRequest, getOrCreateInvite } from '@/features/invite/usecases/invite-to-circle';
import type { JoinApprovalEnvelope, JoinApprovalPayload, JoinRequestPayload } from '@/features/invite/usecases/invite-payloads';
import { cancelPendingJoinRequest, checkPendingJoinRequest, requestToJoin } from '@/features/invite/usecases/join-circle';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { decrypt, encrypt, generateIdentity, sealToPublicKey, sign } from '@/core/crypto/primitives';
import { deriveInviteTag, deriveJoinRequestKey } from '@/features/invite/crypto';
import { compressToThumbnail } from '@/core/photo/image';
import {
  deleteJoinRequest,
  getJoinRequestApproval,
  listJoinRequests,
  putJoinApproval,
  putJoinRequest,
} from '@/core/services/mailbox-relay';
import { JoinRequestGoneError } from '@/core/services/relay-errors';
import { getInvitePreview, createInvitePreview } from '@/features/invite/services/invite-preview-relay';
import { getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { saveMasterSeed } from '@/core/services/keystore/master-seed';
import { appendEntry, bootstrapCircle, fetchEntries } from '@/core/services/log-relay';
import { getBlob } from '@/core/services/blob-relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (getBlob as jest.Mock).mockResolvedValue(null);
  // approveJoinRequest now catches up on meta before sealing, so the
  // approver never hands over a stale key map.
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
});

/**
 * Creates a circle and its invite, capturing exactly what the creator's
 * device published to the mailbox — then wires `getInvitePreview` to hand
 * that same blob back, simulating the relay for a single-process test
 * where "creator" and "requester" run in the same test but never share
 * state except through these mocked relay calls.
 */
async function makeCircleWithInvite(name: string) {
  const { id: circleId } = await createCircle({ name });
  (createInvitePreview as jest.Mock).mockResolvedValue(undefined);
  const invite = await getOrCreateInvite(circleId);

  const [, previewBlob] = (createInvitePreview as jest.Mock).mock.calls[0];
  (getInvitePreview as jest.Mock).mockResolvedValue(previewBlob);

  return { circleId, invite };
}

test('requestToJoin then approveJoinRequest then checkPendingJoinRequest completes the join end to end', async () => {
  const { circleId: creatorCircleId, invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);

  const { requestId } = await requestToJoin(invite.code);

  // Wire listJoinRequests (creator's "discover") to return exactly what
  // the requester just published — the same one-mocked-module trick as
  // the preview above.
  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  (listJoinRequests as jest.Mock).mockResolvedValue([
    { requesterId: requestId, encryptedRequest: requestBlob, encryptedApproval: null, createdAt: Date.now() },
  ]);
  (putJoinApproval as jest.Mock).mockResolvedValue(undefined);

  await approveJoinRequest(creatorCircleId, requestId);

  // Wire getJoinRequestApproval (requester's "poll") to return exactly
  // what the creator just sealed.
  const [, , approvalBlob] = (putJoinApproval as jest.Mock).mock.calls[0];
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(approvalBlob);

  const result = await checkPendingJoinRequest(requestId);

  expect(result.joined).toBe(true);
  if (!result.joined) throw new Error('unreachable');

  const members = await getCircleMembers(result.circleId);
  expect(members).toHaveLength(1);
  expect(members[0].role).toBe('member');

  await expect(getCircle(result.circleId)).resolves.toMatchObject({ name: 'Family Circle' });
  await expect(getPendingJoinRequest(requestId)).resolves.toBeNull();
  expect(drainOutbox).toHaveBeenCalledWith(result.circleId);
});

test('checkPendingJoinRequest fetches and decrypts the circle cover photo when one exists', async () => {
  const { circleId: creatorCircleId, invite } = await makeCircleWithInvite('Family Circle');
  const creatorCurrent = (await getCurrentContentKey(creatorCircleId))!;
  const photo = new Uint8Array([9, 8, 7]);
  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, creatorCurrent.key));
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);

  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  (listJoinRequests as jest.Mock).mockResolvedValue([
    { requesterId: requestId, encryptedRequest: requestBlob, encryptedApproval: null, createdAt: Date.now() },
  ]);
  (putJoinApproval as jest.Mock).mockResolvedValue(undefined);
  await approveJoinRequest(creatorCircleId, requestId);

  const [, , approvalBlob] = (putJoinApproval as jest.Mock).mock.calls[0];
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(approvalBlob);
  const result = await checkPendingJoinRequest(requestId);

  expect(result.joined).toBe(true);
  if (!result.joined) throw new Error('unreachable');
  const creatorCircle = (await getCircle(creatorCircleId))!;
  expect(getBlob).toHaveBeenCalledWith(creatorCircle.syncId, 'cover');
  await expect(getCircle(result.circleId)).resolves.toMatchObject({ picture: photo });
});

test('checkPendingJoinRequest leaves the circle picture null when no cover photo has ever been set', async () => {
  const { circleId: creatorCircleId, invite } = await makeCircleWithInvite('Family Circle');
  // beforeEach already stubs getBlob to resolve null — the "nothing uploaded at this key yet" case.
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);

  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  (listJoinRequests as jest.Mock).mockResolvedValue([
    { requesterId: requestId, encryptedRequest: requestBlob, encryptedApproval: null, createdAt: Date.now() },
  ]);
  (putJoinApproval as jest.Mock).mockResolvedValue(undefined);
  await approveJoinRequest(creatorCircleId, requestId);

  const [, , approvalBlob] = (putJoinApproval as jest.Mock).mock.calls[0];
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(approvalBlob);
  const result = await checkPendingJoinRequest(requestId);

  expect(result.joined).toBe(true);
  if (!result.joined) throw new Error('unreachable');
  await expect(getCircle(result.circleId)).resolves.toMatchObject({ picture: null });
});

test('checkPendingJoinRequest still completes the join even if fetching the cover photo fails', async () => {
  const { circleId: creatorCircleId, invite } = await makeCircleWithInvite('Family Circle');
  (getBlob as jest.Mock).mockRejectedValue(new Error('network error'));
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);

  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  (listJoinRequests as jest.Mock).mockResolvedValue([
    { requesterId: requestId, encryptedRequest: requestBlob, encryptedApproval: null, createdAt: Date.now() },
  ]);
  (putJoinApproval as jest.Mock).mockResolvedValue(undefined);
  await approveJoinRequest(creatorCircleId, requestId);

  const [, , approvalBlob] = (putJoinApproval as jest.Mock).mock.calls[0];
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(approvalBlob);
  const result = await checkPendingJoinRequest(requestId);

  expect(result.joined).toBe(true);
  if (!result.joined) throw new Error('unreachable');
  await expect(getCircle(result.circleId)).resolves.toMatchObject({ picture: null });
});

test('requestToJoin compresses the profile picture into a thumbnail and includes it in the join request', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  await saveProfile({ name: 'Priya Raman', picture: new Uint8Array([9, 9, 9]), createdAt: Date.now(), updatedAt: Date.now() });
  const thumbnail = new Uint8Array([1, 2, 3]);
  (compressToThumbnail as jest.Mock).mockResolvedValue(thumbnail);
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);

  await requestToJoin(invite.code);

  expect(compressToThumbnail).toHaveBeenCalledWith(new Uint8Array([9, 9, 9]));
  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  const key = deriveJoinRequestKey(invite.code);
  const request = JSON.parse(new TextDecoder().decode(decrypt(requestBlob, key))) as JoinRequestPayload;
  expect(request.pictureThumbnail).toBe(Buffer.from(thumbnail).toString('base64'));
});

test('requestToJoin omits pictureThumbnail when the profile has no picture', async () => {
  // Reset the profile to no-picture *before* makeCircleWithInvite, not
  // after — it calls createCircle, which reads the profile too (for its
  // own member_added entry), and a picture left over from an earlier test
  // would make that call compress a thumbnail before this test even gets
  // to requestToJoin, breaking the not-called assertion below.
  await saveProfile({ name: 'Tomás Ruiz', picture: null, createdAt: Date.now(), updatedAt: Date.now() });
  const { invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);

  await requestToJoin(invite.code);

  expect(compressToThumbnail).not.toHaveBeenCalled();
  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  const key = deriveJoinRequestKey(invite.code);
  const request = JSON.parse(new TextDecoder().decode(decrypt(requestBlob, key))) as JoinRequestPayload;
  expect(request.pictureThumbnail).toBeUndefined();
});

test('requestToJoin still submits the request when thumbnail compression fails', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  await saveProfile({ name: 'Priya Raman', picture: new Uint8Array([9, 9, 9]), createdAt: Date.now(), updatedAt: Date.now() });
  (compressToThumbnail as jest.Mock).mockRejectedValue(new Error('unsupported image format'));
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);

  await expect(requestToJoin(invite.code)).resolves.toEqual({ requestId: expect.any(String) });

  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  const key = deriveJoinRequestKey(invite.code);
  const request = JSON.parse(new TextDecoder().decode(decrypt(requestBlob, key))) as JoinRequestPayload;
  expect(request.pictureThumbnail).toBeUndefined();
});

test('requestToJoin throws a clear error when the invite has no preview (bad code, or expired)', async () => {
  (getInvitePreview as jest.Mock).mockResolvedValue(null);

  await expect(requestToJoin('BOGUS-CODE-0000')).rejects.toThrow(/invalid|expired/);
  expect(putJoinRequest).not.toHaveBeenCalled();
});

test('checkPendingJoinRequest returns not-joined for an unknown request id', async () => {
  await expect(checkPendingJoinRequest('unknown-request-id')).resolves.toEqual({ joined: false });
});

test('checkPendingJoinRequest returns not-joined while the approval is still pending', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(null);

  await expect(checkPendingJoinRequest(requestId)).resolves.toEqual({ joined: false });
});

test('an approval signed by anyone other than the invite creator is rejected, even carrying the real circle secret', async () => {
  // Simulates a rogue existing member: knows the real circle secret (every
  // member does) and, via the invite code, the requester's real ephemeral
  // public key too — but signs with its own circle identity, not the
  // creator's. The seal itself is valid (correctly encrypted to the real
  // requester), so only the signature check can catch this.
  const { circleId, invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);
  const pending = await getPendingJoinRequest(requestId);
  const realCircle = (await getCircle(circleId))!;
  const realCurrent = (await getCurrentContentKey(circleId))!;
  const rogueIdentity = generateIdentity();

  const approval: JoinApprovalPayload = { keyMap: { 1: bytesToHex(realCurrent.key) }, syncId: realCircle.syncId, circleName: 'Family Circle' };
  const signature = sign(new TextEncoder().encode(JSON.stringify(approval)), rogueIdentity.secretKey);
  const envelope: JoinApprovalEnvelope = { approval, signature: bytesToHex(signature) };
  const forgedSealed = sealToPublicKey(new TextEncoder().encode(JSON.stringify(envelope)), hexToBytes(pending!.ephemeralPublicKey));
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(forgedSealed);

  await expect(checkPendingJoinRequest(requestId)).resolves.toEqual({ joined: false });
  // The pending row survives a rejected forgery, so a later legitimate approval can still land.
  await expect(getPendingJoinRequest(requestId)).resolves.not.toBeNull();
});

/**
 * A denied or aged-out request will never be answered, so polling it
 * forever leaves the requester on "waiting for approval" indefinitely and
 * logs a failure on every pass.
 */
test('a request the relay no longer has is reported gone and forgotten locally', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);
  (getJoinRequestApproval as jest.Mock).mockRejectedValue(new JoinRequestGoneError());

  await expect(checkPendingJoinRequest(requestId)).resolves.toEqual({ joined: false, gone: true });

  // Forgotten, so nothing polls it again.
  expect(await getPendingJoinRequest(requestId)).toBeNull();
  expect(await getPendingJoinKeypair(requestId)).toBeNull();
});

/** A relay that is merely unreachable must not discard a live request. */
test('a transient failure leaves the request in place', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);
  (getJoinRequestApproval as jest.Mock).mockRejectedValue(new Error('offline'));

  await expect(checkPendingJoinRequest(requestId)).rejects.toThrow('offline');

  expect(await getPendingJoinRequest(requestId)).not.toBeNull();
});

test('cancelling a pending request withdraws it from the mailbox and clears local state', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  (deleteJoinRequest as jest.Mock).mockResolvedValue(undefined);

  const { requestId } = await requestToJoin(invite.code);

  await cancelPendingJoinRequest(requestId);

  expect(deleteJoinRequest).toHaveBeenCalledWith(deriveInviteTag(invite.code), requestId);
  expect(await getPendingJoinRequest(requestId)).toBeNull();
  // The keypair goes too: without it an approval that lands afterwards
  // can't be opened, which is what cancelling should mean.
  expect(await getPendingJoinKeypair(requestId)).toBeNull();
});

// Withdrawing must not depend on reaching the relay — someone asking to
// stop waiting shouldn't be held on a screen by a network error.
test('cancelling clears local state even when the relay is unreachable', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  (deleteJoinRequest as jest.Mock).mockRejectedValue(new Error('offline'));

  const { requestId } = await requestToJoin(invite.code);

  await expect(cancelPendingJoinRequest(requestId)).resolves.toBeUndefined();
  expect(await getPendingJoinRequest(requestId)).toBeNull();
});
