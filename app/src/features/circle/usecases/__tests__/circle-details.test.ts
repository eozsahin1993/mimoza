jest.mock('@/features/invite/services/invite-relay', () => ({ listInvites: jest.fn() }));

import { applyCircle, applyRoster, initDatabase, saveProfile } from '@/data/db';
import { loadCircleDetails } from '@/features/circle/usecases/circle-details';
import { generateUUID } from '@/core/crypto/primitives';
import { listInvites } from '@/features/invite/services/invite-relay';

const invites = listInvites as jest.Mock;
const ACCOUNT_ID = 'account-1';

beforeAll(async () => {
  await initDatabase();
  await saveProfile({ accountId: ACCOUNT_ID, name: 'Founder', deviceId: 'device-1', createdAt: 1, updatedAt: 1 });
});

beforeEach(() => {
  invites.mockReset().mockResolvedValue([]);
});

async function makeCircle(ownRole: string): Promise<string> {
  const circleId = generateUUID();
  const now = Date.now();
  await applyCircle({ circleId, name: 'Family Circle', role: ownRole, notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 }, now);
  await applyRoster(
    circleId,
    [
      { circleId, accountId: ACCOUNT_ID, name: 'Founder', role: ownRole, joinedAt: now },
      { circleId, accountId: 'account-2', name: 'Marcus', role: 'member', joinedAt: now },
    ],
    now,
  );
  return circleId;
}

test('gathers the circle, its roster, and who the reader is', async () => {
  const circleId = await makeCircle('admin');

  const details = await loadCircleDetails(circleId);

  expect(details.circle?.name).toBe('Family Circle');
  expect(details.members).toHaveLength(2);
  expect(details.ownPublicKey).toBe(ACCOUNT_ID);
  expect(details.notifyLevel).toBe('all');
});

test('reports an admin as an admin', async () => {
  const circleId = await makeCircle('admin');

  expect((await loadCircleDetails(circleId)).ownIsAdmin).toBe(true);
});

test('reports a plain member as not an admin', async () => {
  const circleId = await makeCircle('member');

  expect((await loadCircleDetails(circleId)).ownIsAdmin).toBe(false);
});

test("an admin's live invite comes through", async () => {
  const invite = { code: 'ABC123', createdBy: ACCOUNT_ID, createdAt: 1, expiresAt: 2 };
  invites.mockResolvedValue([invite]);
  const circleId = await makeCircle('admin');

  expect((await loadCircleDetails(circleId)).invite).toEqual(invite);
});

test('a member gets no invite, and the relay is never asked for one', async () => {
  const circleId = await makeCircle('member');

  expect((await loadCircleDetails(circleId)).invite).toBeNull();
  expect(invites).not.toHaveBeenCalled();
});

// The screen is worth showing without a code, and the relay refuses the
// read to anyone but an admin anyway — see loadCircleDetails.
test('a failed invite read is swallowed rather than failing the whole screen', async () => {
  invites.mockRejectedValue(new Error('offline'));
  const circleId = await makeCircle('admin');

  expect((await loadCircleDetails(circleId)).invite).toBeNull();
});

test('returns an empty shape for a circle this device does not have', async () => {
  const details = await loadCircleDetails(generateUUID());

  expect(details).toEqual({
    circle: null,
    members: [],
    ownIsAdmin: false,
    // Not null: the profile is a single account-wide row, unlike the old
    // per-circle identity — it resolves whether or not this circle does.
    ownPublicKey: ACCOUNT_ID,
    invite: null,
    notifyLevel: 'all',
  });
  expect(invites).not.toHaveBeenCalled();
});
