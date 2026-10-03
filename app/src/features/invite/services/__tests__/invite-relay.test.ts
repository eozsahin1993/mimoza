jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: {} } }));
jest.mock('@/core/services/keystore/auth-token', () => ({
  getAuthToken: async () => 'test-token',
  deleteAuthToken: async () => undefined,
}));

import { JoinRequestGoneError } from '@/core/services/relay-errors';
import { cancelRequest } from '@/features/invite/services/invite-relay';

function answerWith(status: number, body = ''): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeAll(() => {
  process.env.EXPO_PUBLIC_RELAY_URL = 'http://relay.test';
});

describe('cancelRequest', () => {
  test('is a DELETE on the ask, by circle and id, carrying the session', async () => {
    const fetchMock = answerWith(204);

    await cancelRequest('c1', 'r1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://relay.test/v1/circles/c1/requests/r1');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  // The relay answers 404 for an ask that is someone else's, already
  // answered, or already gone — all of which mean there is nothing left to
  // withdraw, which callers need to tell apart from a failure.
  test('reads a 404 as the ask no longer being there', async () => {
    answerWith(404, '{"error":"circles: no such request"}');

    await expect(cancelRequest('c1', 'r1')).rejects.toBeInstanceOf(JoinRequestGoneError);
  });

  test('any other failure is an ordinary error that names what the relay said', async () => {
    answerWith(500, '{"error":"something went wrong"}');

    const failure = cancelRequest('c1', 'r1');

    await expect(failure).rejects.toThrow('withdrawing an ask: 500 something went wrong');
    await expect(failure).rejects.not.toBeInstanceOf(JoinRequestGoneError);
  });
});
