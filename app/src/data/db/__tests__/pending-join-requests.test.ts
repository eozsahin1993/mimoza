import { generateUUID } from '@/core/crypto/primitives';
import { initDatabase } from '@/data/db';
import {
  deletePendingJoinRequest,
  getAllPendingJoinRequests,
  getPendingJoinRequest,
  insertPendingJoinRequest,
  markPendingJoinRequestApproved,
  PendingJoinRequestStatuses,
} from '@/data/db/pending-join-requests';

beforeAll(() => initDatabase());

function makeRequest(overrides: Partial<{ id: string; inviteCode: string; circleName: string }> = {}) {
  return {
    id: generateUUID(),
    circleId: generateUUID(),
    inviteCode: 'AAAA-BBBB-CCCC',
    circleName: 'Family Circle',
    createdByName: 'Alex',
    createdByPublicKey: 'bb'.repeat(32),
    ephemeralPublicKey: 'aa'.repeat(32),
    submittedAt: Date.now(),
    status: PendingJoinRequestStatuses.pending,
    pushRoutingId: null,
    ...overrides,
  };
}

describe('pendingJoinRequests CRUD', () => {
  test('insertPendingJoinRequest then getPendingJoinRequest returns the same row', async () => {
    const request = makeRequest();
    await insertPendingJoinRequest(request);

    await expect(getPendingJoinRequest(request.id)).resolves.toEqual(request);
  });

  test('getPendingJoinRequest returns null for an unknown id', async () => {
    await expect(getPendingJoinRequest(generateUUID())).resolves.toBeNull();
  });

  test('getAllPendingJoinRequests returns every inserted row', async () => {
    const a = makeRequest({ circleName: 'A' });
    const b = makeRequest({ circleName: 'B' });
    await insertPendingJoinRequest(a);
    await insertPendingJoinRequest(b);

    const all = await getAllPendingJoinRequests();
    expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  test('markPendingJoinRequestApproved updates the status', async () => {
    const request = makeRequest();
    await insertPendingJoinRequest(request);

    await markPendingJoinRequestApproved(request.id);

    await expect(getPendingJoinRequest(request.id)).resolves.toMatchObject({ status: 'approved' });
  });

  test('deletePendingJoinRequest removes the row', async () => {
    const request = makeRequest();
    await insertPendingJoinRequest(request);

    await deletePendingJoinRequest(request.id);

    await expect(getPendingJoinRequest(request.id)).resolves.toBeNull();
  });
});
