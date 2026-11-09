jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  clearLastNotificationResponse: jest.fn(),
  getLastNotificationResponse: jest.fn(),
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/data/db', () => ({
  initDatabase: jest.fn(async () => undefined),
  getPost: jest.fn(async (id: string) => ({ id })),
}));
jest.mock('@/core/services/alerts', () => ({ showAlert: jest.fn() }));
jest.mock('@/core/i18n/i18n', () => ({ i18n: { t: (key: string) => key } }));
jest.mock('@/features/invite/usecases/invite-to-circle', () => ({ discoverPendingRequests: jest.fn(async () => []) }));

import { addNotificationResponseReceivedListener } from 'expo-notifications';
import { router } from 'expo-router';

import { startPushTapRouting } from '@/features/push-notifications/services/tap';

const comment = { circleId: 'circle-1', entryId: 'comment-1', parentEntryId: 'post-1', type: 'comment' };

// What APNs delivers: the relay's fields beside `aps`, not under the
// `body` key expo-notifications fills content.data from.
const iosTap = {
  notification: { request: { content: { data: null }, trigger: { type: 'push', payload: { aps: {}, data: comment } } } },
};
const androidTap = {
  notification: { request: { content: { data: comment }, trigger: { type: 'push' } } },
};

let tap: (response: unknown) => void;

beforeAll(() => {
  startPushTapRouting();
  tap = (addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
});

beforeEach(() => {
  (router.push as jest.Mock).mockClear();
});

test.each([
  ['iOS', iosTap],
  ['Android', androidTap],
])('a comment tapped on %s opens its post over the feed', async (_platform, response) => {
  tap(response);
  await new Promise((resolve) => setImmediate(resolve));

  expect((router.push as jest.Mock).mock.calls).toEqual([
    [{ pathname: '/circle/feed', params: { circleId: 'circle-1' } }],
    [{ pathname: '/post/[id]', params: { id: 'post-1', circleId: 'circle-1' } }],
  ]);
});
