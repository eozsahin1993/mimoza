jest.mock('@/features/circle/services/circle-relay', () => ({
  getRoster: jest.fn(),
  leaveCircle: jest.fn(async () => undefined),
}));
jest.mock('@/features/circle/usecases/change-member-role', () => ({
  ...jest.requireActual('@/features/circle/usecases/change-member-role'),
  setMemberRole: jest.fn(async () => undefined),
}));
jest.mock('@/features/circle/usecases/key-exchange', () => ({ sealForEach: jest.fn(() => ({})) }));
jest.mock('@/features/push-notifications/services/channels', () => ({
  removeCircleNotificationChannel: jest.fn(async () => undefined),
}));

import { applyCircle, getCircle, initDatabase, saveLocalAccount } from '@/data/db';
import { generateUUID } from '@/core/crypto/primitives';
import { getRoster, leaveCircle as leaveOnRelay, type RosterMember } from '@/features/circle/services/circle-relay';
import { setMemberRole } from '@/features/circle/usecases/change-member-role';
import { departingSuccessor, leaveCircle } from '@/features/circle/usecases/leave-circle';

const roster = getRoster as jest.Mock;
const relayLeave = leaveOnRelay as jest.Mock;
const promote = setMemberRole as jest.Mock;
const ME = 'me';

function member(accountId: string, role: string, joinedAt: number): RosterMember {
  return { accountId, name: accountId, role, notifyLevel: 'all', joinedAt };
}

beforeAll(async () => {
  await initDatabase();
  await saveLocalAccount({ accountId: ME, name: 'Me', deviceId: 'device-1', createdAt: 1, updatedAt: 1 });
});

beforeEach(() => {
  jest.clearAllMocks();
});

async function leaveWith(members: RosterMember[]): Promise<string> {
  const circleId = generateUUID();
  await applyCircle(
    { circleId, name: 'Family', role: 'admin', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    Date.now()
  );
  roster.mockResolvedValue({ rosterVersion: 1, keyVersion: 1, keys: {}, members });
  await leaveCircle(circleId);
  return circleId;
}

describe('who inherits the circle', () => {
  test('the longest-standing of everyone else, when the leaver is the only admin', () => {
    const members = [member(ME, 'admin', 1), member('late', 'member', 30), member('early', 'member', 10)];

    expect(departingSuccessor(members, ME)?.accountId).toBe('early');
  });

  test('nobody, when another admin stays', () => {
    const members = [member(ME, 'admin', 1), member('co-admin', 'admin', 5), member('plain', 'member', 2)];

    expect(departingSuccessor(members, ME)).toBeNull();
  });

  test('nobody, when a plain member leaves', () => {
    expect(departingSuccessor([member('boss', 'admin', 1), member(ME, 'member', 2)], ME)).toBeNull();
  });

  test('nobody, when the leaver is the last one in', () => {
    expect(departingSuccessor([member(ME, 'admin', 1)], ME)).toBeNull();
  });
});

describe('leaving a circle', () => {
  test('an only admin promotes the successor first, then leaves', async () => {
    const circleId = await leaveWith([member(ME, 'admin', 1), member('late', 'member', 30), member('early', 'member', 10)]);

    expect(promote).toHaveBeenCalledWith(circleId, 'early', 'admin');
    expect(relayLeave).toHaveBeenCalledTimes(1);
    expect(promote.mock.invocationCallOrder[0]).toBeLessThan(relayLeave.mock.invocationCallOrder[0]);
    expect((await getCircle(circleId))?.leftAt).not.toBeNull();
  });

  test('an admin with a co-admin just leaves', async () => {
    await leaveWith([member(ME, 'admin', 1), member('co-admin', 'admin', 5)]);

    expect(promote).not.toHaveBeenCalled();
    expect(relayLeave).toHaveBeenCalledTimes(1);
  });

  test('the last member out promotes nobody', async () => {
    await leaveWith([member(ME, 'admin', 1)]);

    expect(promote).not.toHaveBeenCalled();
    expect(relayLeave).toHaveBeenCalledTimes(1);
  });

  test('a failed promotion stops the leave, so the circle is never left without an admin', async () => {
    promote.mockRejectedValueOnce(new Error('offline'));

    await expect(leaveWith([member(ME, 'admin', 1), member('other', 'member', 2)])).rejects.toThrow('offline');

    expect(relayLeave).not.toHaveBeenCalled();
  });
});
