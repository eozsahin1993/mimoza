jest.mock('@/data/db', () => ({ getLocalAccount: jest.fn() }));
jest.mock('@/core/services/keystore/auth-token', () => ({ saveAuthToken: jest.fn(async () => undefined) }));
jest.mock('@/features/account/services/account-relay', () => ({ getProfile: jest.fn(async () => ({ name: 'Bob' })) }));
jest.mock('@/features/account/services/auth-relay', () => ({
  signInAsDevAccount: jest.fn(async () => ({ token: 'token', accountId: 'acc-bob' })),
}));
jest.mock('@/features/dev/dev-reset', () => ({ resetLocalDataForTesting: jest.fn(async () => undefined) }));

import { getLocalAccount } from '@/data/db';
import { DEV_ACCOUNTS, signInWithDevAccount } from '@/features/dev/dev-sign-in';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';

const BOB = DEV_ACCOUNTS[1];

beforeEach(() => jest.clearAllMocks());

describe('signInWithDevAccount', () => {
  test("wipes another account's local data but keeps its keypair", async () => {
    (getLocalAccount as jest.Mock).mockResolvedValue({ accountId: 'acc-carol' });

    await signInWithDevAccount(BOB);

    expect(resetLocalDataForTesting).toHaveBeenCalledWith({ keepKeypair: true });
  });

  test('leaves the same account\'s data alone', async () => {
    (getLocalAccount as jest.Mock).mockResolvedValue({ accountId: 'acc-bob' });

    const result = await signInWithDevAccount(BOB);

    expect(resetLocalDataForTesting).not.toHaveBeenCalled();
    expect(result.relayProfile).toEqual({ accountId: 'acc-bob', name: 'Bob' });
  });
});
