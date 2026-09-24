import {
  AttachmentKinds,
  AttachmentStatuses,
  coverEntryId,
  forgetProfile,
  getAttachment,
  getCircle,
  initDatabase,
  listCircles,
  listEveryMemberSeen,
  listLeftCircles,
  listMembers,
  listRequests,
  markAttachmentFetched,
  saveProfile,
  upsertRequest,
} from '@/data/db';
import { syncCircles } from '@/core/sync/sync-circles';
import type { Circle, Roster } from '@/features/circle/services/circle-relay';

jest.mock('@/features/circle/services/circle-relay', () => ({
  listCircles: jest.fn(),
  getRoster: jest.fn(),
  rewrapKeys: jest.fn(async () => undefined),
}));
jest.mock('@/features/post/services/post-relay', () => ({
  ...jest.requireActual('@/features/post/services/post-relay'),
  walkEntries: jest.fn(async () => ({ entries: [], more: false })),
}));
jest.mock('@/features/circle/usecases/key-exchange', () => ({
  storeSealedKeys: jest.fn(async () => undefined),
  resealFor: jest.fn(async () => undefined),
}));
jest.mock('@/core/services/keystore/circle-keys', () => ({
  getCircleKeyMap: jest.fn(async () => ({ 1: new Uint8Array(32).fill(1), 3: new Uint8Array(32).fill(1) })),
  getCurrentContentKey: jest.fn(async () => ({ version: 1, key: new Uint8Array(32).fill(1) })),
}));
jest.mock('@/core/photo/photo-queue', () => ({ nudgePhotoQueue: jest.fn() }));

const relay = jest.requireMock('@/features/circle/services/circle-relay') as {
  listCircles: jest.Mock;
  getRoster: jest.Mock;
};
const keys = jest.requireMock('@/features/circle/usecases/key-exchange') as {
  storeSealedKeys: jest.Mock;
  resealFor: jest.Mock;
};
const circleKeys = jest.requireMock('@/core/services/keystore/circle-keys') as {
  getCircleKeyMap: jest.Mock;
};

const NOW = 1_700_000_000_000;

let next = 0;
function circleId(): string {
  next += 1;
  return `circle-${next}`;
}

function circleOf(id: string, overrides: Partial<Circle> = {}): Circle {
  return {
    circleId: id,
    name: 'Family',
    role: 'member',
    notifyLevel: 'all',
    keyVersion: 1,
    rosterVersion: 1,
    ...overrides,
  };
}

function roster(overrides: Partial<Roster> = {}): Roster {
  return {
    rosterVersion: 1,
    keyVersion: 1,
    members: [{ accountId: 'me', name: 'Me', publicKey: 'aa', role: 'member', notifyLevel: 'all', joinedAt: NOW }],
    keys: { 1: 'sealed' },
    ...overrides,
  };
}

beforeAll(async () => {
  await initDatabase();
  await saveProfile({ accountId: 'me', name: 'Me', deviceId: 'phone', createdAt: NOW, updatedAt: NOW });
});

beforeEach(() => {
  jest.clearAllMocks();
  relay.getRoster.mockResolvedValue(roster());
});

describe('a sync pass', () => {
  // Sign-in saves the auth token, which is the scheduler's only gate,
  // before profile setup ever writes this row — so a foreground trigger
  // can land in that gap. Nothing here knows which account this device
  // is yet, so the pass must do nothing rather than guess.
  test('with no local profile yet, does nothing and calls the relay for nothing', async () => {
    await forgetProfile('me');
    try {
      expect(await syncCircles()).toBe(0);
      expect(relay.listCircles).not.toHaveBeenCalled();
    } finally {
      await saveProfile({ accountId: 'me', name: 'Me', deviceId: 'phone', createdAt: NOW, updatedAt: NOW });
    }
  });

  test('takes the roster and keys for a circle it has not seen', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id)], requests: [] });

    expect(await syncCircles()).toBe(0);

    expect(keys.storeSealedKeys).toHaveBeenCalledWith(id, { 1: 'sealed' }, 'me');
    expect((await getCircle(id))?.name).toBe('Family');
    expect(await listMembers(id)).toHaveLength(1);
  });

  // The whole point of the versions: nothing changed means one call.
  test('skips the roster when neither version moved', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id)], requests: [] });
    await syncCircles();
    relay.getRoster.mockClear();

    await syncCircles();

    expect(relay.getRoster).not.toHaveBeenCalled();
  });

  test('refetches when the roster version moves', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id)], requests: [] });
    await syncCircles();
    relay.getRoster.mockClear();

    relay.listCircles.mockResolvedValue({ circles: [circleOf(id, { rosterVersion: 2 })], requests: [] });
    await syncCircles();

    expect(relay.getRoster).toHaveBeenCalledTimes(1);
  });

  // Departures set leftAt rather than deleting, so a post by someone who
  // has gone still resolves to a name.
  test('a member who left the roster is kept, marked as gone', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id)], requests: [] });
    relay.getRoster.mockResolvedValue(
      roster({
        members: [
          { accountId: 'me', name: 'Me', publicKey: 'aa', role: 'member', notifyLevel: 'all', joinedAt: NOW },
          { accountId: 'ali', name: 'Ali', publicKey: 'bb', role: 'member', notifyLevel: 'all', joinedAt: NOW },
        ],
      })
    );
    await syncCircles();

    relay.listCircles.mockResolvedValue({ circles: [circleOf(id, { rosterVersion: 2 })], requests: [] });
    relay.getRoster.mockResolvedValue(roster({ rosterVersion: 2 }));
    await syncCircles();

    expect(await listMembers(id)).toHaveLength(1);
    expect((await listEveryMemberSeen(id)).map((member) => member.name).sort()).toEqual(['Ali', 'Me']);
  });

  // Left, not gone: what was already synced stays readable offline.
  test('a circle the relay stops listing becomes a local archive', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id)], requests: [] });
    await syncCircles();

    relay.listCircles.mockResolvedValue({ circles: [], requests: [] });
    await syncCircles();

    expect((await listCircles()).map((circle) => circle.id)).not.toContain(id);
    expect((await listLeftCircles()).map((circle) => circle.id)).toContain(id);
  });

  test('reseals for a member who replaced their keypair', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id)], requests: [] });
    relay.getRoster.mockResolvedValue(
      roster({
        members: [
          { accountId: 'me', name: 'Me', publicKey: 'aa', role: 'member', notifyLevel: 'all', joinedAt: NOW },
          { accountId: 'ali', name: 'Ali', publicKey: 'bb', role: 'member', notifyLevel: 'all', joinedAt: NOW, needsRewrap: true },
        ],
      })
    );

    await syncCircles();

    expect(keys.resealFor).toHaveBeenCalledTimes(1);
    expect(keys.resealFor.mock.calls[0][1].accountId).toBe('ali');
  });

  // This account's own flag is cleared by somebody else; it holds no keys
  // to seal from.
  test('does not try to reseal when this account is the one waiting', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id, { needsRewrap: true })], requests: [] });
    relay.getRoster.mockResolvedValue(
      roster({
        members: [{ accountId: 'me', name: 'Me', publicKey: 'aa', role: 'member', notifyLevel: 'all', joinedAt: NOW, needsRewrap: true }],
      })
    );

    await syncCircles();

    expect(keys.resealFor).not.toHaveBeenCalled();
  });

  test('one broken circle does not stop the rest', async () => {
    const good = circleId();
    const bad = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(bad), circleOf(good)], requests: [] });
    relay.getRoster.mockImplementation(async (id: string) => {
      if (id === bad) throw new Error('refused');
      return roster();
    });

    expect(await syncCircles()).toBe(1);
    expect(await listMembers(good)).toHaveLength(1);
  });

  // applyCircle commits the relay's new versions locally before the
  // roster fetch they gate has even run. Left uncorrected on failure,
  // the next pass's rosterMoved check compares the local row against
  // itself and finds nothing moved — silently and permanently skipping
  // a roster/key fetch that never actually succeeded.
  test('a failed roster fetch does not stop the next pass from retrying', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id, { rosterVersion: 2 })], requests: [] });
    relay.getRoster.mockRejectedValueOnce(new Error('offline'));

    expect(await syncCircles()).toBe(1);
    expect(await listMembers(id)).toHaveLength(0);

    relay.getRoster.mockResolvedValue(roster({ rosterVersion: 2 }));
    expect(await syncCircles()).toBe(0);
    expect(await listMembers(id)).toHaveLength(1);
  });

  // Same failure, but on a circle this device has never seen before —
  // there is no prior local row to roll back to, so the rollback must
  // use a sentinel no real relay version can ever equal.
  test('a failed roster fetch on a brand-new circle still retries next pass', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id)], requests: [] });
    relay.getRoster.mockRejectedValueOnce(new Error('offline'));

    expect(await syncCircles()).toBe(1);

    relay.getRoster.mockResolvedValue(roster());
    expect(await syncCircles()).toBe(0);
    expect(await listMembers(id)).toHaveLength(1);
  });

  // Queuing the cover ahead of a roster/key fetch that then fails would
  // hand the photo queue a keyVersion this device never got a chance to
  // fetch, and it would fail immediately with "no content key for
  // version N" instead of waiting for the next pass's chance.
  test('a failed roster fetch does not queue the cover for a version this device has no key for yet', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({
      circles: [circleOf(id, { coverId: 'cover-1', coverKeyVersion: 3 })],
      requests: [],
    });
    relay.getRoster.mockRejectedValueOnce(new Error('offline'));

    expect(await syncCircles()).toBe(1);
    expect(await getAttachment(id, coverEntryId('cover-1'))).toBeNull();

    relay.getRoster.mockResolvedValue(roster());
    expect(await syncCircles()).toBe(0);
    expect(await getAttachment(id, coverEntryId('cover-1'))).not.toBeNull();
  });

  // storeSealedKeys swallows a version it cannot open rather than
  // throwing (it's waiting on someone else's reseal), so the ordering fix
  // above alone would not have caught this one: the roster/key block
  // finishes "successfully" with this device still missing the version.
  test('a roster sync that leaves this device without the cover key yet does not queue it', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({
      circles: [circleOf(id, { coverId: 'cover-1', coverKeyVersion: 3 })],
      requests: [],
    });
    circleKeys.getCircleKeyMap.mockResolvedValueOnce({ 1: new Uint8Array(32).fill(1) });

    expect(await syncCircles()).toBe(0);
    expect(await getAttachment(id, coverEntryId('cover-1'))).toBeNull();

    expect(await syncCircles()).toBe(0);
    expect(await getAttachment(id, coverEntryId('cover-1'))).not.toBeNull();
  });

  test('a cover with a key version becomes a pending attachment other devices can fetch', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({
      circles: [circleOf(id, { coverId: 'cover-1', coverKeyVersion: 3 })],
      requests: [],
    });

    await syncCircles();

    const attachment = await getAttachment(id, coverEntryId('cover-1'));
    expect(attachment?.kind).toBe(AttachmentKinds.CIRCLE_COVER);
    expect(attachment?.keyVersion).toBe(3);
    expect(attachment?.status).toBe(AttachmentStatuses.PENDING);
  });

  // A cover set before the relay carried a version has nothing to fetch
  // it with — queuing it would just retry forever and never succeed.
  test('a cover with no key version is left alone rather than queued to fail forever', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({ circles: [circleOf(id, { coverId: 'cover-1' })], requests: [] });

    await syncCircles();

    expect(await getAttachment(id, coverEntryId('cover-1'))).toBeNull();
  });

  test('a repeat sync of the same cover does not reset an already-fetched attachment back to pending', async () => {
    const id = circleId();
    relay.listCircles.mockResolvedValue({
      circles: [circleOf(id, { coverId: 'cover-1', coverKeyVersion: 3 })],
      requests: [],
    });
    await syncCircles();
    await markAttachmentFetched(id, coverEntryId('cover-1'), new Uint8Array([1, 2, 3]));

    await syncCircles();

    const attachment = await getAttachment(id, coverEntryId('cover-1'));
    expect(attachment?.status).toBe(AttachmentStatuses.FETCHED);
    expect(attachment?.bytes).not.toBeNull();
  });

  test('a request the relay no longer lists has been answered', async () => {
    const id = circleId();
    await upsertRequest({ circleId: id, inviteCode: 'CODE', circleName: 'Family', submittedAt: NOW, status: 'pending' });
    relay.listCircles.mockResolvedValue({ circles: [], requests: [] });

    await syncCircles();

    expect(await listRequests()).toEqual([]);
  });

  // The invite code is this device's own and is never echoed back, so a
  // status update must not wipe it.
  test('an updated request keeps the invite code it was made with', async () => {
    const id = circleId();
    await upsertRequest({ circleId: id, inviteCode: 'CODE', circleName: '', submittedAt: NOW, status: 'pending' });
    relay.listCircles.mockResolvedValue({
      circles: [],
      requests: [{ circleId: id, circleName: 'Family', status: 'pending', createdAt: NOW }],
    });

    await syncCircles();

    const [request] = await listRequests();
    expect(request.inviteCode).toBe('CODE');
    expect(request.circleName).toBe('Family');
  });
});
