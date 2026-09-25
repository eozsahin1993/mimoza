import { applyCircle, getRequest, initDatabase, upsertRequest } from '@/data/db';
import { checkPendingJoinRequest } from '@/features/invite/usecases/join-circle';

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
