import { readFileSync } from 'fs';
import { resolve } from 'path';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: {} } }));
jest.mock('@/core/services/keystore/auth-token', () => ({
  getAuthToken: async () => 'test-token',
  deleteAuthToken: async () => undefined,
}));

import { createCircle, leaveCircle, patchMembership, removeMember, renameCircle, rewrapKeys, setCover } from '@/features/circle/services/circle-relay';
import {
  approveRequest,
  cancelRequest,
  denyRequest,
  listRequests,
  requestToJoin,
} from '@/features/invite/services/invite-relay';
import { addComment, putPost, react, setVisibility } from '@/features/post/services/post-relay';

/**
 * The client and the relay are tested separately and pass separately
 * while disagreeing about a field name — a body key the handler does not
 * read is simply absent, and a required one reads as its zero value. Two
 * of those shipped: `sealed` where the relay reads `sealedKey`, which
 * would have failed on the first circle anyone made.
 *
 * So this reads the json tags straight out of the Go request structs and
 * checks that every key the client actually sends is one of them. It
 * cannot prove the relay is reachable; it does prove the two halves of
 * this repo still use the same words.
 */
const SERVER = resolve(__dirname, '../../../../../server');

function goFields(file: string, struct: string): string[] {
  const source = readFileSync(resolve(SERVER, file), 'utf8');
  const block = source.match(new RegExp(`type ${struct} struct \\{([\\s\\S]*?)\\n\\}`));
  if (!block) throw new Error(`No struct ${struct} in ${file} — it was renamed or moved.`);
  return [...block[1].matchAll(/json:"([^",]+)/g)].map((match) => match[1]);
}

async function bodyOf(call: () => Promise<unknown>): Promise<string[]> {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '{}',
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  await call();
  const [, init] = fetchMock.mock.calls[0];
  return Object.keys(JSON.parse(init.body));
}

beforeAll(() => {
  process.env.EXPO_PUBLIC_RELAY_URL = 'http://relay.test';
});

describe('what the client sends is what the relay reads', () => {
  test.each([
    [
      'creating a circle',
      () => createCircle('Family', 'sealed-key'),
      'internal/circles/circle/create.go',
      'createRequest',
    ],
    [
      'renaming a circle',
      () => renameCircle('c1', 'Family'),
      'internal/circles/circle/patch.go',
      'patchRequest',
    ],
    ['setting a cover', () => setCover('c1', 'cover-1', 1), 'internal/circles/circle/patch.go', 'patchRequest'],
    [
      'changing a membership',
      () => patchMembership('c1', 'a1', { role: 'admin', notifyLevel: 'all' }),
      'internal/circles/members/patch.go',
      'patchRequest',
    ],
    [
      'leaving',
      () => leaveCircle('c1', 2, { '2': 'sealed' }),
      'internal/circles/members/rotation_request.go',
      'rotationRequest',
    ],
    [
      'removing a member',
      () => removeMember('c1', 'a1', 2, { '2': 'sealed' }),
      'internal/circles/members/rotation_request.go',
      'rotationRequest',
    ],
    [
      'resealing keys',
      () => rewrapKeys('c1', 'a1', { '1': 'sealed' }),
      'internal/circles/members/rewrap.go',
      'rewrapRequest',
    ],
    [
      'approving an ask',
      () => approveRequest('c1', 'r1', { '1': 'sealed' }),
      'internal/circles/requests/approve.go',
      'approveRequest',
    ],
    [
      'posting',
      () => putPost('c1', { entryId: 'p1', keyVersion: 1, ciphertext: 'x', hasBlob: true, visibility: 'album' }),
      'internal/circles/posts/put.go',
      'putRequest',
    ],
    [
      'commenting',
      () => addComment('c1', 'p1', { commentId: 'k1', keyVersion: 1, ciphertext: 'x', parentCommentId: 'k0' }),
      'internal/circles/comments/add.go',
      'addRequest',
    ],
    [
      'reacting',
      () => react('c1', 'p1', { tag: 'deadbeef', keyVersion: 1, ciphertext: 'x' }),
      'internal/circles/reactions/set.go',
      'setRequest',
    ],
    [
      'changing visibility',
      () => setVisibility('c1', 'p1', 'feed'),
      'internal/circles/posts/patch.go',
      'patchRequest',
    ],
  ])('%s', async (_name, call, file, struct) => {
    const sent = await bodyOf(call);
    const read = goFields(file, struct);

    expect(sent.length).toBeGreaterThan(0);
    expect(read).toEqual(expect.arrayContaining(sent));
  });
});

/**
 * The one field the relay returns that nothing else would miss: an
 * approving admin seals to it, and the requester is not on the roster
 * yet, so this ask is the only place it is published.
 */
test('a join request carries the key an approver seals to', () => {
  expect(goFields('internal/circles/requests/request_response.go', 'requestResponse')).toContain('publicKey');
});

/**
 * A client that calls a route the relay does not register gets a 404 that
 * reads as "that ask is gone", which is exactly what withdrawing, approving
 * and denying treat it as. So the paths themselves are checked against
 * what the relay mounts, not just the bodies.
 */
function goRoutes(file: string): { method: string; pattern: RegExp }[] {
  const source = readFileSync(resolve(SERVER, file), 'utf8');
  return [...source.matchAll(/\{"(GET|POST|PUT|PATCH|DELETE) (\/[^"]+)"/g)].map(([, method, path]) => ({
    method,
    pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  }));
}

async function requestOf(call: () => Promise<unknown>): Promise<{ method: string; path: string }> {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}), text: async () => '{}' });
  global.fetch = fetchMock as unknown as typeof fetch;

  await call();
  const [url, init] = fetchMock.mock.calls[0];
  return { method: init?.method ?? 'GET', path: new URL(url).pathname.replace(/^\/v1/, '') };
}

describe('the join routes the client calls are ones the relay serves', () => {
  const routes = goRoutes('internal/circles/requests/router.go');

  test.each([
    ['asking to join', () => requestToJoin('CODE'), 'POST', '/invites/CODE/requests'],
    ['listing the asks', () => listRequests('c1'), 'GET', '/circles/c1/requests'],
    ['approving an ask', () => approveRequest('c1', 'r1', { '1': 'sealed' }), 'POST', '/circles/c1/requests/r1/approve'],
    ['denying an ask', () => denyRequest('c1', 'r1'), 'POST', '/circles/c1/requests/r1/deny'],
    ['withdrawing an ask', () => cancelRequest('c1', 'r1'), 'DELETE', '/circles/c1/requests/r1'],
  ])('%s', async (_name, call, method, path) => {
    const sent = await requestOf(call);

    expect(sent).toEqual({ method, path });
    expect(routes.some((route) => route.method === sent.method && route.pattern.test(sent.path))).toBe(true);
  });
});

/** What withdrawing an ask names: the sync list is the only place this device learns it. */
test('the relay names each ask a device is waiting on', () => {
  expect(goFields('internal/circles/circle/list.go', 'pendingResponse')).toContain('requestId');
});
