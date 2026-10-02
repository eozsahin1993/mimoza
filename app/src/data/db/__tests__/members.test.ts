import { initDatabase } from '@/data/db';
import { applyCircle, markCircleLeft } from '@/data/db/circles';
import {
  applyRoster,
  findCircleSharedWith,
  getMember,
  listEveryMemberSeen,
  listMembers,
  rememberDepartedMember,
  setMemberRole,
} from '@/data/db/members';

const NOW = 1_700_000_000_000;

let next = 0;
function circleId(): string {
  next += 1;
  return `circle-${next}`;
}

async function seedCircle(id: string) {
  await applyCircle(
    { circleId: id, name: 'Family', role: 'admin', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
}

function member(accountId: string, overrides: Partial<Parameters<typeof applyRoster>[1][number]> = {}) {
  return {
    circleId: '',
    accountId,
    name: accountId,
    publicKey: 'pk-' + accountId,
    role: 'member',
    joinedAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await initDatabase();
});

// A roster read is the whole truth about who is in a circle now.
test('a roster replaces who is in the circle', async () => {
  const circle = circleId();
  await seedCircle(circle);

  await applyRoster(circle, [member('acc-1'), member('acc-2')], NOW);
  expect((await listMembers(circle)).map((row) => row.accountId).sort()).toEqual(['acc-1', 'acc-2']);

  await applyRoster(circle, [member('acc-1'), member('acc-3')], NOW + 100);
  expect((await listMembers(circle)).map((row) => row.accountId).sort()).toEqual(['acc-1', 'acc-3']);
});

// Someone who left is marked, not deleted: their old posts still have to
// resolve to a name.
test('a member who leaves keeps their name', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await applyRoster(circle, [member('acc-1', { name: 'Ali' }), member('acc-2')], NOW);
  await applyRoster(circle, [member('acc-2')], NOW + 100);

  const departed = await getMember(circle, 'acc-1');
  expect(departed?.leftAt).toBe(NOW + 100);
  expect(departed?.name).toBe('Ali');
  expect(await listMembers(circle)).toHaveLength(1);
  expect(await listEveryMemberSeen(circle)).toHaveLength(2);
});

// Rejoining clears the mark rather than leaving a ghost.
test('a member who comes back is present again', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await applyRoster(circle, [member('acc-1')], NOW);
  await applyRoster(circle, [], NOW + 100);
  await applyRoster(circle, [member('acc-1')], NOW + 200);

  expect((await getMember(circle, 'acc-1'))?.leftAt).toBeNull();
});

// A stale joinedAt would make the next departure look like the one being
// replayed from before this rejoin, per SYNC_DESIGN.md's use of joinedAt
// to tell a stale "left" activity entry apart from a real one.
test('a member who comes back gets their new joinedAt, not the old one', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await applyRoster(circle, [member('acc-1', { joinedAt: NOW })], NOW);
  await applyRoster(circle, [], NOW + 100);
  await applyRoster(circle, [member('acc-1', { joinedAt: NOW + 200 })], NOW + 200);

  expect((await getMember(circle, 'acc-1'))?.joinedAt).toBe(NOW + 200);
});

// A deleted account never appears on a roster again, so the name comes
// from the activity row that recorded it.
test('a departed account can be remembered by name alone', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await rememberDepartedMember(circle, 'acc-gone', 'Sarah', NOW);

  const remembered = await getMember(circle, 'acc-gone');
  expect(remembered?.name).toBe('Sarah');
  expect(remembered?.leftAt).toBe(NOW);
  expect(await listMembers(circle)).toHaveLength(0);
});

// A profile picture is account-level now, so it rides straight in on the
// roster row rather than being set through a dedicated call.
test('a profile picture id arrives with the roster', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await applyRoster(circle, [member('acc-1', { profilePictureId: 'pic-1' })], NOW);

  expect((await getMember(circle, 'acc-1'))?.profilePictureId).toBe('pic-1');
});

// Absent on the relay's own roster member reads back null, not
// undefined — callers branch on `!profilePictureId` to skip resolving one.
test('no profilePictureId on the roster reads back null, not undefined', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await applyRoster(circle, [member('acc-1')], NOW);

  expect((await getMember(circle, 'acc-1'))?.profilePictureId).toBeNull();
});

// What the picture queue needs to address a download: any live circle
// this device shares with that account, regardless of which one.
//
// The account id is unique per test here, not the file's usual 'acc-1'/
// 'acc-2' — findCircleSharedWith has no circleId to scope by, so two
// tests reusing the same account id would see each other's circles.
test('findCircleSharedWith finds a live circle the account belongs to', async () => {
  const circle = circleId();
  const friend = `friend-${circle}`;
  await seedCircle(circle);
  await applyRoster(circle, [member('acc-1'), member(friend)], NOW);

  expect(await findCircleSharedWith(friend)).toBe(circle);
});

test('findCircleSharedWith is null once the account has left every circle', async () => {
  const circle = circleId();
  const friend = `friend-${circle}`;
  await seedCircle(circle);
  await applyRoster(circle, [member('acc-1'), member(friend)], NOW);
  await applyRoster(circle, [member('acc-1')], NOW + 100);

  expect(await findCircleSharedWith(friend)).toBeNull();
});

// This device having left the circle itself is just as disqualifying as
// the other account having left it — either way there is no route left
// to address a download through.
test('findCircleSharedWith is null once this device has left the circle', async () => {
  const circle = circleId();
  const friend = `friend-${circle}`;
  await seedCircle(circle);
  await applyRoster(circle, [member('acc-1'), member(friend)], NOW);
  await markCircleLeft(circle, NOW + 100);

  expect(await findCircleSharedWith(friend)).toBeNull();
});

// applyRoster takes its argument as the whole roster, so promoting
// through it with one entry would mark everybody else as having left.
test('changing one role leaves the rest of the roster alone', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await applyRoster(
    circle,
    [
      { circleId: circle, accountId: 'a', name: 'Ada', publicKey: 'aa', role: 'admin', joinedAt: NOW },
      { circleId: circle, accountId: 'b', name: 'Bo', publicKey: 'bb', role: 'member', joinedAt: NOW },
      { circleId: circle, accountId: 'c', name: 'Cy', publicKey: 'cc', role: 'member', joinedAt: NOW },
    ],
    NOW
  );

  await setMemberRole(circle, 'b', 'admin');

  expect(await listMembers(circle)).toHaveLength(3);
  expect((await getMember(circle, 'b'))?.role).toBe('admin');
  expect((await getMember(circle, 'a'))?.leftAt).toBeNull();
  expect((await getMember(circle, 'c'))?.leftAt).toBeNull();
});
