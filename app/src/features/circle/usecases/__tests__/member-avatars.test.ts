import { AttachmentKinds, AttachmentStatuses, applyCircle, avatarEntryId, initDatabase, insertAttachment } from '@/data/db';
import { resolveMemberAvatars } from '@/features/circle/usecases/member-avatars';

const NOW = 1_700_000_000_000;

let next = 0;
async function makeCircle(): Promise<string> {
  next += 1;
  const circleId = `circle-${next}`;
  await applyCircle(
    { circleId, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
  return circleId;
}

beforeAll(async () => {
  await initDatabase();
});

test("resolves an account's picture once its bytes have arrived", async () => {
  const circleId = await makeCircle();
  await insertAttachment({
    circleId,
    entryId: avatarEntryId('ali', 'avatar-1'),
    kind: AttachmentKinds.MEMBER_AVATAR,
    bytes: new Uint8Array([1, 2, 3]),
    status: AttachmentStatuses.FETCHED,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt: NOW,
  });

  const resolved = await resolveMemberAvatars(circleId, [{ accountId: 'ali', avatarId: 'avatar-1' }]);

  // AQID is [1, 2, 3] base64-encoded — bytes straight to a data URI, no file cache involved.
  expect(resolved.get('ali')).toBe('data:image/jpeg;base64,AQID');
});

// No avatarId at all — never set one — is the common case, and must not
// cost an attachment lookup that could only ever miss.
test('skips a member with no avatarId', async () => {
  const circleId = await makeCircle();

  const resolved = await resolveMemberAvatars(circleId, [{ accountId: 'ali', avatarId: null }]);

  expect(resolved.has('ali')).toBe(false);
});

// The roster already carries the new avatarId, but the queue hasn't
// downloaded its bytes yet — absent, not a broken link, so the caller
// falls back to initials until the next fetch lands.
test('skips a member whose avatar is still downloading', async () => {
  const circleId = await makeCircle();
  await insertAttachment({
    circleId,
    entryId: avatarEntryId('ali', 'avatar-2'),
    kind: AttachmentKinds.MEMBER_AVATAR,
    status: AttachmentStatuses.PENDING,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt: NOW,
  });

  const resolved = await resolveMemberAvatars(circleId, [{ accountId: 'ali', avatarId: 'avatar-2' }]);

  expect(resolved.has('ali')).toBe(false);
});

test('resolves every account passed in, independently', async () => {
  const circleId = await makeCircle();
  await insertAttachment({
    circleId,
    entryId: avatarEntryId('ali', 'avatar-3'),
    kind: AttachmentKinds.MEMBER_AVATAR,
    bytes: new Uint8Array([4, 5, 6]),
    status: AttachmentStatuses.FETCHED,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt: NOW,
  });

  const resolved = await resolveMemberAvatars(circleId, [
    { accountId: 'ali', avatarId: 'avatar-3' },
    { accountId: 'sam', avatarId: null },
  ]);

  expect(resolved.has('ali')).toBe(true);
  expect(resolved.has('sam')).toBe(false);
});
