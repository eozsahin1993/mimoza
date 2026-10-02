import { initDatabase } from '@/data/db';
import { forgetLocalAccount, getLocalAccount, saveLocalAccount } from '@/data/db/local-account';

const ACCOUNT = 'acc-1';

beforeAll(() => initDatabase());

describe('local account', () => {
  test('there is none before signing in', async () => {
    await expect(getLocalAccount()).resolves.toBeNull();
  });

  test('a saved account reads back', async () => {
    await saveLocalAccount({ accountId: ACCOUNT, name: 'Emre', deviceId: 'phone-1', createdAt: 1000, updatedAt: 1000 });

    const account = await getLocalAccount();
    expect(account?.accountId).toBe(ACCOUNT);
    expect(account?.name).toBe('Emre');
    expect(account?.deviceId).toBe('phone-1');
  });

  // The picture lives in profilePictures now, keyed by this same
  // accountId — there is nothing picture-shaped left here to round-trip.
  test('saving again keeps the account and the moment it was created', async () => {
    await saveLocalAccount({ accountId: ACCOUNT, name: 'Emre Ozsahin', deviceId: 'phone-1', createdAt: 9999, updatedAt: 2000 });

    const account = await getLocalAccount();
    expect(account?.name).toBe('Emre Ozsahin');
    expect(account?.createdAt).toBe(1000);
    expect(account?.updatedAt).toBe(2000);
  });

  test('deleting the account forgets it', async () => {
    await forgetLocalAccount(ACCOUNT);
    await expect(getLocalAccount()).resolves.toBeNull();
  });
});
