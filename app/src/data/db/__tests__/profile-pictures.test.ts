import {
  applyCircle,
  applyRoster,
  deleteProfilePicture,
  getFetchableProfilePictures,
  getProfilePicture,
  getProfilePictures,
  initDatabase,
  markCircleLeft,
  markProfilePictureFailed,
  markProfilePictureFetched,
  storeProfilePicture,
  upsertProfilePictureRef,
} from '@/data/db';

const NOW = 1_700_000_000_000;

// profile_pictures is keyed by accountId alone — no circleId — so every
// test below uses an id unique to it, the same lesson sync-circles.test.ts
// and photo-queue.test.ts learned the hard way: the database persists
// across tests in this file, and a reused account id would read back
// whatever an earlier test left on it.
let next = 0;
function accountId(): string {
  next += 1;
  return `acc-${next}`;
}

/** A live circle with this account as a member — what getFetchableProfilePictures gates on. */
async function makeSharedCircle(account: string): Promise<string> {
  const circleId = `circle-${account}`;
  await applyCircle({ circleId, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 }, NOW);
  await applyRoster(circleId, [{ circleId, accountId: account, name: 'Someone', publicKey: 'pk', role: 'member', joinedAt: NOW }], NOW);
  return circleId;
}

beforeAll(() => initDatabase());

describe('upsertProfilePictureRef', () => {
  test('records a new account as pending, with no bytes yet', async () => {
    const id = accountId();

    await upsertProfilePictureRef(id, 'pic-1', NOW);

    const picture = await getProfilePicture(id);
    expect(picture?.pictureId).toBe('pic-1');
    expect(picture?.status).toBe('pending');
    expect(picture?.bytes).toBeNull();
  });

  // The guard that makes a roster refresh that changed nothing about
  // pictures cost nothing: without it, re-upserting the same id would
  // reset already-fetched bytes back to pending for no reason.
  test('does not reset an already-fetched picture when the id has not changed', async () => {
    const id = accountId();
    await upsertProfilePictureRef(id, 'pic-1', NOW);
    await markProfilePictureFetched(id, 'pic-1', new Uint8Array([1, 2, 3]));

    await upsertProfilePictureRef(id, 'pic-1', NOW + 100);

    const picture = await getProfilePicture(id);
    expect(picture?.status).toBe('fetched');
    expect(picture?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('a changed id resets bytes and status back to pending', async () => {
    const id = accountId();
    await upsertProfilePictureRef(id, 'pic-1', NOW);
    await markProfilePictureFetched(id, 'pic-1', new Uint8Array([1, 2, 3]));

    await upsertProfilePictureRef(id, 'pic-2', NOW + 100);

    const picture = await getProfilePicture(id);
    expect(picture?.pictureId).toBe('pic-2');
    expect(picture?.status).toBe('pending');
    expect(picture?.bytes).toBeNull();
    expect(picture?.fetchAttempts).toBe(0);
  });

  test('a changed id clears whatever backoff the old one was sitting out', async () => {
    const id = accountId();
    await upsertProfilePictureRef(id, 'pic-1', NOW);
    await markProfilePictureFailed(id, 'pic-1', 3, NOW + 10_000);

    await upsertProfilePictureRef(id, 'pic-2', NOW + 100);

    const picture = await getProfilePicture(id);
    expect(picture?.fetchAttempts).toBe(0);
    expect(picture?.nextAttemptAt).toBeNull();
  });
});

describe('storeProfilePicture', () => {
  test('writes bytes straight to fetched, for a device seeding its own picture', async () => {
    const id = accountId();

    await storeProfilePicture(id, 'pic-1', new Uint8Array([9, 9, 9]));

    const picture = await getProfilePicture(id);
    expect(picture?.pictureId).toBe('pic-1');
    expect(picture?.status).toBe('fetched');
    expect(picture?.bytes).toEqual(new Uint8Array([9, 9, 9]));
  });

  test('overwrites whatever was there before, id and bytes both', async () => {
    const id = accountId();
    await storeProfilePicture(id, 'pic-1', new Uint8Array([1]));

    await storeProfilePicture(id, 'pic-2', new Uint8Array([2]));

    const picture = await getProfilePicture(id);
    expect(picture?.pictureId).toBe('pic-2');
    expect(picture?.bytes).toEqual(new Uint8Array([2]));
  });
});

describe('getProfilePicture / getProfilePictures', () => {
  test('a never-seen account reads back null', async () => {
    expect(await getProfilePicture(accountId())).toBeNull();
  });

  test('resolves several accounts in one query, skipping those with no row', async () => {
    const a = accountId();
    const b = accountId();
    const ghost = accountId();
    await storeProfilePicture(a, 'pic-a', new Uint8Array([1]));
    await storeProfilePicture(b, 'pic-b', new Uint8Array([2]));

    const pictures = await getProfilePictures([a, b, ghost]);

    expect(pictures.size).toBe(2);
    expect(pictures.get(a)?.pictureId).toBe('pic-a');
    expect(pictures.get(b)?.pictureId).toBe('pic-b');
    expect(pictures.has(ghost)).toBe(false);
  });

  test('an empty list of ids resolves to an empty map', async () => {
    expect(await getProfilePictures([])).toEqual(new Map());
  });
});

describe('getFetchableProfilePictures', () => {
  test('a pending picture for an account this device shares a live circle with is fetchable', async () => {
    const id = accountId();
    await makeSharedCircle(id);
    await upsertProfilePictureRef(id, 'pic-1', NOW);

    const rows = await getFetchableProfilePictures(NOW, 10);

    expect(rows.map((row) => row.accountId)).toContain(id);
  });

  test('an account this device shares no circle with is not fetchable', async () => {
    const id = accountId();
    await upsertProfilePictureRef(id, 'pic-1', NOW);

    const rows = await getFetchableProfilePictures(NOW, 10);

    expect(rows.map((row) => row.accountId)).not.toContain(id);
  });

  // Once this device has left the shared circle locally, there is no
  // longer a route to address a download through — same reasoning as
  // getFetchableAttachments' own liveCircles subquery.
  test('an account whose only shared circle this device has left is not fetchable', async () => {
    const id = accountId();
    const circleId = await makeSharedCircle(id);
    await upsertProfilePictureRef(id, 'pic-1', NOW);
    await markCircleLeft(circleId, NOW + 100);

    const rows = await getFetchableProfilePictures(NOW, 10);

    expect(rows.map((row) => row.accountId)).not.toContain(id);
  });

  test('a picture with bytes already fetched is not fetchable again', async () => {
    const id = accountId();
    await makeSharedCircle(id);
    await storeProfilePicture(id, 'pic-1', new Uint8Array([1]));

    const rows = await getFetchableProfilePictures(NOW, 10);

    expect(rows.map((row) => row.accountId)).not.toContain(id);
  });

  // Asserts by membership, not by the result's overall length: the query
  // is global across every account, so earlier tests' own still-pending
  // rows are legitimately still in there too — this test only owns the
  // claim about its own id.
  test('a picture still sitting out its backoff is not fetchable yet', async () => {
    const id = accountId();
    await makeSharedCircle(id);
    await upsertProfilePictureRef(id, 'pic-1', NOW);
    await markProfilePictureFailed(id, 'pic-1', 1, NOW + 10_000);

    expect((await getFetchableProfilePictures(NOW, 50)).map((row) => row.accountId)).not.toContain(id);
    expect((await getFetchableProfilePictures(NOW + 10_000, 50)).map((row) => row.accountId)).toContain(id);
  });
});

describe('markProfilePictureFetched / markProfilePictureFailed', () => {
  test('a failure records the attempt count and backoff, leaving the picture pending-for-bytes', async () => {
    const id = accountId();
    await upsertProfilePictureRef(id, 'pic-1', NOW);

    await markProfilePictureFailed(id, 'pic-1', 2, NOW + 60_000);

    const picture = await getProfilePicture(id);
    expect(picture?.status).toBe('failed');
    expect(picture?.fetchAttempts).toBe(2);
    expect(picture?.nextAttemptAt).toBe(NOW + 60_000);
    expect(picture?.bytes).toBeNull();
  });

  test('a later fetch clears the failure state', async () => {
    const id = accountId();
    await upsertProfilePictureRef(id, 'pic-1', NOW);
    await markProfilePictureFailed(id, 'pic-1', 2, NOW + 60_000);

    await markProfilePictureFetched(id, 'pic-1', new Uint8Array([5]));

    const picture = await getProfilePicture(id);
    expect(picture?.status).toBe('fetched');
    expect(picture?.fetchAttempts).toBe(0);
    expect(picture?.nextAttemptAt).toBeNull();
  });

  // The actual point of taking pictureId as a parameter: a fetch that
  // was running against an id this row has since moved past (a newer
  // upsertProfilePictureRef landed while it was in flight) must not
  // overwrite the row that id was replaced by.
  test('a completion for an id the row has since moved past is a no-op', async () => {
    const id = accountId();
    await upsertProfilePictureRef(id, 'pic-1', NOW);
    await upsertProfilePictureRef(id, 'pic-2', NOW + 100); // moved on before pic-1's fetch landed

    await markProfilePictureFetched(id, 'pic-1', new Uint8Array([1, 2, 3]));

    const picture = await getProfilePicture(id);
    expect(picture?.pictureId).toBe('pic-2');
    expect(picture?.status).toBe('pending');
    expect(picture?.bytes).toBeNull();
  });

  // Same guard, failure side: a stale id's backoff must not land on
  // whatever id is current now.
  test('a failure for an id the row has since moved past is a no-op', async () => {
    const id = accountId();
    await upsertProfilePictureRef(id, 'pic-1', NOW);
    await upsertProfilePictureRef(id, 'pic-2', NOW + 100);

    await markProfilePictureFailed(id, 'pic-1', 3, NOW + 60_000);

    const picture = await getProfilePicture(id);
    expect(picture?.pictureId).toBe('pic-2');
    expect(picture?.status).toBe('pending');
    expect(picture?.fetchAttempts).toBe(0);
    expect(picture?.nextAttemptAt).toBeNull();
  });
});

describe('deleteProfilePicture', () => {
  test('removes the row outright, not just its bytes', async () => {
    const id = accountId();
    await storeProfilePicture(id, 'pic-1', new Uint8Array([1]));

    await deleteProfilePicture(id);

    expect(await getProfilePicture(id)).toBeNull();
  });

  test('is a no-op for an account with no row', async () => {
    await expect(deleteProfilePicture(accountId())).resolves.toBeUndefined();
  });
});
