import { JoinRequestGoneError } from '@/core/services/relay-errors';
import { applyCircle, getRequest, initDatabase, listRequests, upsertRequest } from '@/data/db';
import { cancelPendingJoinRequest, checkPendingJoinRequest } from '@/features/invite/usecases/join-circle';

jest.mock('@/features/circle/services/circle-relay', () => ({ listCircles: jest.fn() }));
jest.mock('@/features/invite/services/invite-relay', () => ({
  cancelRequest: jest.fn(),
  previewInvite: jest.fn(),
  requestToJoin: jest.fn(),
}));

const relay = jest.requireMock('@/features/circle/services/circle-relay') as { listCircles: jest.Mock };
const invites = jest.requireMock('@/features/invite/services/invite-relay') as { cancelRequest: jest.Mock };

const NOW = 1_700_000_000_000;

beforeAll(async () => {
  await initDatabase();
});

let next = 0;
function circleId(): string {
  next += 1;
  return `circle-${next}`;
}

describe('checkPendingJoinRequest', () => {
  // The circle appearing locally is how a sync reports approval — see
  // join-circle.ts's own comment. Leaving the request row behind once
  // that's happened is what left "waiting to join" showing an invite
  // that had already been let in.
  test('drops the local request once the circle has been synced in', async () => {
    const id = circleId();
    await upsertRequest({ circleId: id, inviteCode: 'abc', circleName: 'Family', submittedAt: NOW, status: 'pending' });
    await applyCircle(
      { circleId: id, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
      NOW
    );

    const result = await checkPendingJoinRequest(id);

    expect(result).toEqual({ state: 'approved', circleId: id });
    expect(await getRequest(id)).toBeNull();
  });

  test('reports pending while neither the circle nor a denial has arrived', async () => {
    const id = circleId();
    await upsertRequest({ circleId: id, inviteCode: 'abc', circleName: 'Family', submittedAt: NOW, status: 'pending' });

    expect(await checkPendingJoinRequest(id)).toEqual({ state: 'pending' });
  });

  test('reports gone once the request is answered with anything but approval', async () => {
    const id = circleId();
    await upsertRequest({ circleId: id, inviteCode: 'abc', circleName: 'Family', submittedAt: NOW, status: 'denied' });

    expect(await checkPendingJoinRequest(id)).toEqual({ state: 'gone' });
  });

  test('reports gone when there is no local record at all', async () => {
    expect(await checkPendingJoinRequest(circleId())).toEqual({ state: 'gone' });
  });
});

describe('cancelPendingJoinRequest', () => {
  beforeEach(() => {
    relay.listCircles.mockReset();
    invites.cancelRequest.mockReset().mockResolvedValue(undefined);
  });

  async function waitingOn(id: string): Promise<void> {
    await upsertRequest({ circleId: id, inviteCode: 'abc', circleName: 'Family', submittedAt: NOW, status: 'pending' });
  }

  function relayListing(...requests: Record<string, unknown>[]): void {
    relay.listCircles.mockResolvedValue({ circles: [], requests });
  }

  // The relay keeps an ask listed until it is answered or expires, so
  // forgetting it only here would bring it back on the next sync and
  // leave an admin able to approve it.
  test('withdraws an open ask on the relay by the id the relay gave it', async () => {
    const id = circleId();
    await waitingOn(id);
    relayListing({ requestId: 'req-1', circleId: id, status: 'pending', createdAt: NOW });

    await cancelPendingJoinRequest(id);

    expect(invites.cancelRequest).toHaveBeenCalledWith(id, 'req-1');
  });

  test('forgets the ask here only after the relay has dropped it', async () => {
    const id = circleId();
    await waitingOn(id);
    relayListing({ requestId: 'req-1', circleId: id, status: 'pending', createdAt: NOW });
    let heldWhenRelayWasAsked: unknown = 'not asked';
    invites.cancelRequest.mockImplementation(async () => {
      heldWhenRelayWasAsked = await getRequest(id);
    });

    await cancelPendingJoinRequest(id);

    expect(heldWhenRelayWasAsked).not.toBeNull();
    expect(await getRequest(id)).toBeNull();
  });

  test('keeps the ask when the relay refuses, so it is never silently forgotten', async () => {
    const id = circleId();
    await waitingOn(id);
    relayListing({ requestId: 'req-1', circleId: id, status: 'pending', createdAt: NOW });
    invites.cancelRequest.mockRejectedValue(new Error('withdrawing an ask: 500'));

    await expect(cancelPendingJoinRequest(id)).rejects.toThrow('withdrawing an ask: 500');

    expect(await getRequest(id)).not.toBeNull();
  });

  test('keeps the ask when the relay cannot be reached to look it up', async () => {
    const id = circleId();
    await waitingOn(id);
    relay.listCircles.mockRejectedValue(new Error('offline'));

    await expect(cancelPendingJoinRequest(id)).rejects.toThrow('offline');

    expect(invites.cancelRequest).not.toHaveBeenCalled();
    expect(await getRequest(id)).not.toBeNull();
  });

  // A lost response followed by a retry, or an admin answering first:
  // either way the ask is no longer there to withdraw, which is what was
  // wanted.
  test('an ask the relay says is already gone counts as withdrawn', async () => {
    const id = circleId();
    await waitingOn(id);
    relayListing({ requestId: 'req-1', circleId: id, status: 'pending', createdAt: NOW });
    invites.cancelRequest.mockRejectedValue(new JoinRequestGoneError());

    await cancelPendingJoinRequest(id);

    expect(await getRequest(id)).toBeNull();
  });

  test('an ask the relay no longer lists is forgotten without asking it to withdraw anything', async () => {
    const id = circleId();
    await waitingOn(id);
    relayListing();

    await cancelPendingJoinRequest(id);

    expect(invites.cancelRequest).not.toHaveBeenCalled();
    expect(await getRequest(id)).toBeNull();
  });

  test.each(['denied', 'approved'])('an ask already %s is forgotten without being withdrawn', async (status) => {
    const id = circleId();
    await waitingOn(id);
    relayListing({ requestId: 'req-1', circleId: id, status, createdAt: NOW });

    await cancelPendingJoinRequest(id);

    expect(invites.cancelRequest).not.toHaveBeenCalled();
    expect(await getRequest(id)).toBeNull();
  });

  // A relay that predates the id would otherwise turn this into a silent
  // local-only cancel, which is the bug this exists to prevent.
  test('refuses, and keeps the ask, when the relay did not name it', async () => {
    const id = circleId();
    await waitingOn(id);
    relayListing({ circleId: id, status: 'pending', createdAt: NOW });

    await expect(cancelPendingJoinRequest(id)).rejects.toThrow('did not name this ask');

    expect(invites.cancelRequest).not.toHaveBeenCalled();
    expect(await getRequest(id)).not.toBeNull();
  });

  test('only withdraws the ask for that circle', async () => {
    const mine = circleId();
    const other = circleId();
    await waitingOn(mine);
    await waitingOn(other);
    relayListing(
      { requestId: 'req-other', circleId: other, status: 'pending', createdAt: NOW },
      { requestId: 'req-mine', circleId: mine, status: 'pending', createdAt: NOW }
    );

    await cancelPendingJoinRequest(mine);

    expect(invites.cancelRequest).toHaveBeenCalledTimes(1);
    expect(invites.cancelRequest).toHaveBeenCalledWith(mine, 'req-mine');
    expect((await listRequests()).map((request) => request.circleId)).toContain(other);
    expect(await getRequest(mine)).toBeNull();
  });
});
