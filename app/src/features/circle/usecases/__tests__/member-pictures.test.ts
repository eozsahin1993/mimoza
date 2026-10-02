import { initDatabase, storeProfilePicture, upsertProfilePictureRef } from '@/data/db';
import { resolveMemberPictures } from '@/features/circle/usecases/member-pictures';

const NOW = 1_700_000_000_000;

beforeAll(() => initDatabase());

test('resolves a fetched picture to a file uri', async () => {
  await storeProfilePicture('acc-1', 'pic-1', new Uint8Array([1, 2, 3]));

  const resolved = await resolveMemberPictures(['acc-1']);

  expect(resolved.get('acc-1')).toMatch(/^file:\/\//);
});

// Writing the file is cheap to skip the second time: the first resolve
// already put it on disk under this exact pictureId, so a later resolve
// for the same account must not write it again.
test('a second resolve reuses the cached file rather than rewriting it', async () => {
  await storeProfilePicture('acc-2', 'pic-1', new Uint8Array([4, 5, 6]));
  const first = await resolveMemberPictures(['acc-2']);

  const second = await resolveMemberPictures(['acc-2']);

  expect(second.get('acc-2')).toBe(first.get('acc-2'));
});

// Known about (a roster reported the id) but not downloaded yet — the
// common case right after a roster sync, before the picture queue has
// had its turn.
test('an account with no bytes yet is simply absent from the result', async () => {
  await upsertProfilePictureRef('acc-3', 'pic-1', NOW);

  const resolved = await resolveMemberPictures(['acc-3']);

  expect(resolved.has('acc-3')).toBe(false);
});

test('an account with no picture row at all is simply absent', async () => {
  const resolved = await resolveMemberPictures(['never-seen']);

  expect(resolved.has('never-seen')).toBe(false);
});

test('resolves several accounts in one pass, each to its own uri', async () => {
  await storeProfilePicture('acc-4', 'pic-4', new Uint8Array([7]));
  await storeProfilePicture('acc-5', 'pic-5', new Uint8Array([8]));

  const resolved = await resolveMemberPictures(['acc-4', 'acc-5', 'never-seen-either']);

  expect(resolved.size).toBe(2);
  expect(resolved.get('acc-4')).not.toBe(resolved.get('acc-5'));
});

test('an empty list resolves to an empty map without touching the database', async () => {
  expect(await resolveMemberPictures([])).toEqual(new Map());
});
