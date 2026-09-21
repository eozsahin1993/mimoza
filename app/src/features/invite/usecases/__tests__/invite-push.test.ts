jest.mock('@/core/services/push-relay');
jest.mock('@/features/push-notifications/services/tokens');
jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/mailbox-relay');
jest.mock('@/features/invite/services/invite-preview-relay');
jest.mock('@/core/photo/image');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/blob-relay');

import { getInvitesWithPushRouting, getPendingJoinRequest, initDatabase, revokeInvite } from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import { approveJoinRequest, getOrCreateInvite, replaceInvite } from '@/features/invite/usecases/invite-to-circle';
import type { InvitePreviewPayload, JoinRequestPayload } from '@/features/invite/usecases/invite-payloads';
import { applyInvitePushMask, readJoinRequestPush, sweepInvitePush, unregisterInvitePushDevice } from '@/features/invite/usecases/invite-push';
import { purgeCircleLocally } from '@/features/circle/usecases/purge-circle';
import { requestToJoin } from '@/features/invite/usecases/join-circle';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { decrypt, encryptJSON } from '@/core/crypto/primitives';
import { deriveInvitePreviewKey, deriveInvitePushFanoutToken, deriveJoinRequestKey } from '@/features/invite/crypto';
import { derivePushFanoutHash } from '@/core/crypto/push';
import { handlePush } from '@/features/push-notifications/usecases/handle-push';
import { resolvePushDestination } from '@/features/push-notifications/usecases/push-destination';
import { INVITES_CHANNEL_ID } from '@/features/push-notifications/services/channels';
import { ALL_INVITE_PUSH, InvitePushCategories } from '@/features/push-notifications/usecases/push-categories';
import { listJoinRequests, putJoinApproval, putJoinRequest } from '@/core/services/mailbox-relay';
import { createInvitePreview, getInvitePreview } from '@/features/invite/services/invite-preview-relay';
import { deletePushDevice, deletePushRouting, putPushDevice, putPushPrefs, sendPush } from '@/core/services/push-relay';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';
import { saveMasterSeed } from '@/core/services/keystore/master-seed';
import { appendEntry, bootstrapCircle, fetchEntries } from '@/core/services/log-relay';
import { getBlob } from '@/core/services/blob-relay';
import { i18n } from '@/core/i18n/i18n';
import { updateAppSettings } from '@/core/services/settings';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { bytesToHex } from '@noble/curves/utils.js';
import { getSecret } from '@/core/services/keystore/store';

const device = { pushToken: 'fcm-registration-token', platform: 'android' as const };

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (getBlob as jest.Mock).mockResolvedValue(null);
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
  for (const fn of [putPushPrefs, putPushDevice, deletePushDevice, deletePushRouting, sendPush, createInvitePreview, putJoinRequest, putJoinApproval]) {
    (fn as jest.Mock).mockResolvedValue(undefined);
  }
  (getDevicePushToken as jest.Mock).mockResolvedValue(device);
  await AsyncStorage.clear();
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(3));
});

/** Lets the device row, added without being awaited, land. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A circle, its invite, and the preview a tapped link would read back. */
async function makeCircleWithInvite(name: string) {
  const { id: circleId } = await createCircle({ name });
  const invite = await getOrCreateInvite(circleId);
  await settle();
  const [, previewBlob] = (createInvitePreview as jest.Mock).mock.calls.at(-1);
  (getInvitePreview as jest.Mock).mockResolvedValue(previewBlob);
  const preview = JSON.parse(new TextDecoder().decode(decrypt(previewBlob, deriveInvitePreviewKey(invite.code)))) as InvitePreviewPayload;
  return { circleId, invite, preview };
}

/** The prefs write for one kind of routing, as the relay mock saw it. */
function prefsCall(kind: string) {
  const call = (putPushPrefs as jest.Mock).mock.calls.find((args) => args[5] === kind);
  if (!call) throw new Error(`no ${kind} routing was registered`);
  return { routingId: call[0] as string, fanoutHash: call[1] as Uint8Array, categories: call[2] as number[], order: (putPushPrefs as jest.Mock).mock.invocationCallOrder[(putPushPrefs as jest.Mock).mock.calls.indexOf(call)] };
}

describe('the creator', () => {
  test('claims the invite routing before the preview names it', async () => {
    const { invite, preview } = await makeCircleWithInvite('Family Circle');
    const routing = prefsCall('invite');

    expect(routing.categories).toEqual([InvitePushCategories.joinRequest]);
    expect(routing.fanoutHash).toEqual(derivePushFanoutHash(deriveInvitePushFanoutToken(invite.code), routing.routingId));
    expect(routing.order).toBeLessThan((createInvitePreview as jest.Mock).mock.invocationCallOrder[0]);
    expect(putPushDevice).toHaveBeenCalledWith(routing.routingId, expect.any(String), device.pushToken, device.platform, true, expect.any(Uint8Array));

    expect(preview.pushRoutingId).toBe(routing.routingId);
    expect(invite.pushRoutingId).toBe(routing.routingId);
  });

  test('an invite is still created when push can\'t be registered, and names no routing', async () => {
    (putPushPrefs as jest.Mock).mockRejectedValueOnce(new Error('push routes down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const { invite, preview } = await makeCircleWithInvite('Family Circle');

    expect(invite.pushRoutingId).toBeNull();
    expect(preview.pushRoutingId).toBeUndefined();
  });

  /** Replacing a link is meant to cut the old one off, not wait out its week. */
  test('replacing the link deletes the old routing and forgets it', async () => {
    const { circleId, invite } = await makeCircleWithInvite('Family Circle');

    const next = await replaceInvite(circleId);

    expect(deletePushRouting).toHaveBeenCalledWith(invite.pushRoutingId, expect.any(Uint8Array));
    expect((await getInvitesWithPushRouting()).map((row) => row.code)).toEqual([next.code]);
  });

  test('a failed delete is left for the launch sweep, which finishes it', async () => {
    const { circleId, invite } = await makeCircleWithInvite('Family Circle');
    (deletePushRouting as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await replaceInvite(circleId);
    expect((await getInvitesWithPushRouting()).map((row) => row.code)).toContain(invite.code);

    await sweepInvitePush();
    expect((await getInvitesWithPushRouting()).map((row) => row.code)).not.toContain(invite.code);
  });

  test('the sweep re-sends this device for a live invite, since tokens rotate', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    jest.clearAllMocks();
    (getDevicePushToken as jest.Mock).mockResolvedValue(device);
    (putPushDevice as jest.Mock).mockResolvedValue(undefined);

    await sweepInvitePush();

    expect(putPushDevice).toHaveBeenCalledWith(invite.pushRoutingId, expect.any(String), device.pushToken, device.platform, true, expect.any(Uint8Array));
    expect(deletePushRouting).not.toHaveBeenCalled();
  });

  test('the sweep removes a revoked invite\'s routing, and its key for the iOS extension', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    expect(await getSecret(`invite_join_request_key_${invite.pushRoutingId}`)).toBe(bytesToHex(deriveJoinRequestKey(invite.code)));
    await revokeInvite(invite.code);

    await sweepInvitePush();

    expect(deletePushRouting).toHaveBeenCalledWith(invite.pushRoutingId, expect.any(Uint8Array));
    expect(await getSecret(`invite_join_request_key_${invite.pushRoutingId}`)).toBeNull();
  });
});

describe('the requester', () => {
  test('claims their own routing before the request shares it, then tells the creator', async () => {
    const { invite, preview } = await makeCircleWithInvite('Family Circle');

    const { requestId } = await requestToJoin(invite.code);

    const pending = prefsCall('pending_request');
    expect(pending.categories).toEqual([InvitePushCategories.joinApproved]);
    expect(pending.order).toBeLessThan((putJoinRequest as jest.Mock).mock.invocationCallOrder[0]);

    const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
    const request = JSON.parse(new TextDecoder().decode(decrypt(requestBlob, deriveJoinRequestKey(invite.code)))) as JoinRequestPayload;
    expect(request.pushRoutingId).toBe(pending.routingId);
    expect((await getPendingJoinRequest(requestId))?.pushRoutingId).toBe(pending.routingId);

    const [routingIds, token, category, , payload] = (sendPush as jest.Mock).mock.calls[0];
    expect(routingIds).toEqual([preview.pushRoutingId]);
    expect(token).toEqual(deriveInvitePushFanoutToken(invite.code));
    expect(category).toBe(InvitePushCategories.joinRequest);
    expect(readJoinRequestPush(payload, invite.code)).toBe(request.selfReportedName);
  });

  /** Only the prefs write claims the routing; the device row is best-effort. */
  test('a device that fails to register doesn\'t stop the request', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    (putPushDevice as jest.Mock).mockRejectedValueOnce(new Error('relay hiccup'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(requestToJoin(invite.code)).resolves.toHaveProperty('requestId');

    expect(putJoinRequest).toHaveBeenCalledTimes(1);
  });

  /** The iOS simulator can register with APNs forever; the request mustn't wait on it. */
  test('a device token that never arrives doesn\'t hold the request up', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    (getDevicePushToken as jest.Mock).mockReturnValue(new Promise(() => {}));

    await expect(requestToJoin(invite.code)).resolves.toHaveProperty('requestId');

    expect(putJoinRequest).toHaveBeenCalledTimes(1);
  });

  /** A first request comes before permission; turning notifications on runs the sweep. */
  test('a request made without permission gets this device once notifications are on', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    (getDevicePushToken as jest.Mock).mockResolvedValue(null);
    await requestToJoin(invite.code);
    await settle();
    const pendingRoutingId = prefsCall('pending_request').routingId;
    expect(putPushDevice).not.toHaveBeenCalledWith(pendingRoutingId, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());

    (getDevicePushToken as jest.Mock).mockResolvedValue(device);
    await sweepInvitePush();

    expect(putPushDevice).toHaveBeenCalledWith(pendingRoutingId, expect.any(String), device.pushToken, device.platform, true, expect.any(Uint8Array));
  });

  test('the sweep leaves pending requests alone with answers switched off', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    await updateAppSettings({ invitePushMask: 1 << InvitePushCategories.joinRequest });
    await requestToJoin(invite.code);
    await settle();
    const pendingRoutingId = prefsCall('pending_request').routingId;

    await sweepInvitePush();

    expect((putPushDevice as jest.Mock).mock.calls.map((args) => args[0])).not.toContain(pendingRoutingId);
  });

  /** Push is best-effort: it never costs the request. */
  test('a request still goes out when push can\'t be registered', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    (putPushPrefs as jest.Mock).mockRejectedValueOnce(new Error('push routes down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const { requestId } = await requestToJoin(invite.code);

    expect(putJoinRequest).toHaveBeenCalledTimes(1);
    expect((await getPendingJoinRequest(requestId))?.pushRoutingId).toBeNull();
  });

  test('is told the creator accepted, carrying the approval the mailbox got', async () => {
    const { circleId, invite } = await makeCircleWithInvite('Family Circle');
    const { requestId } = await requestToJoin(invite.code);
    const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
    (listJoinRequests as jest.Mock).mockResolvedValue([
      { requesterId: requestId, encryptedRequest: requestBlob, encryptedApproval: null, createdAt: Date.now() },
    ]);

    await approveJoinRequest(circleId, requestId);

    const [routingIds, token, category, , payload] = (sendPush as jest.Mock).mock.calls.at(-1);
    expect(routingIds).toEqual([prefsCall('pending_request').routingId]);
    expect(token).toEqual(deriveInvitePushFanoutToken(invite.code));
    expect(category).toBe(InvitePushCategories.joinApproved);
    expect(payload).toEqual((putJoinApproval as jest.Mock).mock.calls[0][2]);

    const pending = await getPendingJoinRequest(requestId);
    const notification = await handlePush({ pushRoutingId: pending!.pushRoutingId!, kind: 'pending_request', payload: Buffer.from(payload).toString('base64') });
    const accepted = pending!.createdByName ? i18n.t('push.joinApproved', { name: pending!.createdByName }) : i18n.t('push.joinApprovedNoName');
    expect(notification).toMatchObject({ channelId: INVITES_CHANNEL_ID, title: 'Family Circle', body: accepted });
  });
});

describe('receiving', () => {
  test('a join request reads "Priya wants to join", under the circle, in the invites channel', async () => {
    const { circleId, invite } = await makeCircleWithInvite('Family Circle');
    const payload = encryptJSON({ requesterId: 'r1', selfReportedName: 'Priya' }, deriveJoinRequestKey(invite.code));

    const notification = await handlePush({ pushRoutingId: invite.pushRoutingId!, kind: 'invite', payload: Buffer.from(payload).toString('base64') });

    expect(notification).toEqual({
      circleId,
      channelId: INVITES_CHANNEL_ID,
      title: 'Family Circle',
      body: i18n.t('push.joinRequest', { name: 'Priya' }),
    });
    await expect(resolvePushDestination({ pushRoutingId: invite.pushRoutingId!, kind: 'invite' })).resolves.toEqual({ screen: 'feed', circleId });
  });

  test('a payload that won\'t open still says someone wants to join', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');

    const notification = await handlePush({ pushRoutingId: invite.pushRoutingId!, kind: 'invite', payload: Buffer.from('garbage').toString('base64') });

    expect(notification?.body).toBe(i18n.t('push.joinRequest', { name: i18n.t('push.someone') }));
  });

  /** Anyone with the code can send this push, so one that doesn't verify claims only news. */
  test('an approval push that doesn\'t verify says only there\'s news, and opens the pending screen', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    const { requestId } = await requestToJoin(invite.code);
    const routingId = prefsCall('pending_request').routingId;

    for (const payload of [undefined, Buffer.from('forged').toString('base64')]) {
      const notification = await handlePush({ pushRoutingId: routingId, kind: 'pending_request', payload });
      expect(notification).toMatchObject({ channelId: INVITES_CHANNEL_ID, title: 'Family Circle', body: i18n.t('push.joinRequestNews') });
    }
    await expect(resolvePushDestination({ pushRoutingId: routingId, kind: 'pending_request' })).resolves.toEqual({ screen: 'pending', requestId });
  });

  test('a routing this device doesn\'t know shows nothing', async () => {
    await expect(handlePush({ pushRoutingId: 'ab'.repeat(32), kind: 'invite' })).resolves.toBeNull();
    await expect(handlePush({ pushRoutingId: 'ab'.repeat(32), kind: 'pending_request' })).resolves.toBeNull();
  });
});

describe('the account switches', () => {
  test('with the join request bit off, a new invite claims its routing but adds no device', async () => {
    await updateAppSettings({ invitePushMask: 1 << InvitePushCategories.joinApproved });

    await makeCircleWithInvite('Family Circle');

    expect(prefsCall('invite')).toBeDefined();
    expect(putPushDevice).not.toHaveBeenCalled();
  });

  test('switching invites off and on removes and restores this phone on the live invite', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');

    await applyInvitePushMask(0);
    expect(deletePushDevice).toHaveBeenCalledWith(invite.pushRoutingId, expect.any(String), expect.any(Uint8Array));
    expect(deletePushRouting).not.toHaveBeenCalled();

    (putPushDevice as jest.Mock).mockClear();
    await applyInvitePushMask(ALL_INVITE_PUSH);
    expect(putPushDevice).toHaveBeenCalledWith(invite.pushRoutingId, expect.any(String), device.pushToken, device.platform, true, expect.any(Uint8Array));
  });

  /** The two bits are independent underneath: one never touches the other's routings. */
  test('clearing only the answers bit leaves the invite alone and removes this phone from the pending request', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    await requestToJoin(invite.code);
    const pendingRoutingId = prefsCall('pending_request').routingId;

    await applyInvitePushMask(1 << InvitePushCategories.joinRequest);

    expect((deletePushDevice as jest.Mock).mock.calls.map(([routingId]) => routingId)).toEqual([pendingRoutingId]);
  });

  test('the launch sweep respects the join request bit being off', async () => {
    await makeCircleWithInvite('Family Circle');
    await updateAppSettings({ invitePushMask: 1 << InvitePushCategories.joinApproved });
    (putPushDevice as jest.Mock).mockClear();

    await sweepInvitePush();

    expect(putPushDevice).not.toHaveBeenCalled();
  });
});

describe('leaving and signing out', () => {
  /** The invite rows go with the circle, and they're the only record the sweep has. */
  test('dropping a circle unregisters its invite routing first', async () => {
    const { circleId, invite } = await makeCircleWithInvite('Family Circle');

    await purgeCircleLocally(circleId);

    expect(deletePushRouting).toHaveBeenCalledWith(invite.pushRoutingId, expect.any(Uint8Array));
  });

  /** The iOS extension shows these lines from the kind alone, signed in or not. */
  test('signing out removes this phone from invite and pending routings, leaving the prefs', async () => {
    const { invite } = await makeCircleWithInvite('Family Circle');
    await requestToJoin(invite.code);
    const pendingRoutingId = prefsCall('pending_request').routingId;

    await unregisterInvitePushDevice();

    expect((deletePushDevice as jest.Mock).mock.calls.map(([routingId]) => routingId).sort()).toEqual([invite.pushRoutingId, pendingRoutingId].sort());
    expect(deletePushRouting).not.toHaveBeenCalled();
  });
});
