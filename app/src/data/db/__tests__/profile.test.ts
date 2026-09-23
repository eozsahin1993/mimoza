import { initDatabase } from '@/data/db';
import { forgetProfile, getProfile, saveProfile } from '@/data/db/profile';

const ACCOUNT = 'acc-1';

beforeAll(() => initDatabase());

describe('device profile', () => {
  test('there is none before signing in', async () => {
    await expect(getProfile()).resolves.toBeNull();
  });

  test('a saved profile reads back', async () => {
    await saveProfile({ accountId: ACCOUNT, name: 'Emre', deviceId: 'phone-1', createdAt: 1000, updatedAt: 1000 });

    const profile = await getProfile();
    expect(profile?.accountId).toBe(ACCOUNT);
    expect(profile?.name).toBe('Emre');
    expect(profile?.deviceId).toBe('phone-1');
  });

  // The picture is the original, kept so it can be sealed again for each
  // circle: there is no account-level avatar on the relay.
  test('saving again keeps the account and the moment it was created', async () => {
    const picture = new Uint8Array([1, 2, 3]);
    await saveProfile({ accountId: ACCOUNT, name: 'Emre Ozsahin', picture, deviceId: 'phone-1', createdAt: 9999, updatedAt: 2000 });

    const profile = await getProfile();
    expect(profile?.name).toBe('Emre Ozsahin');
    expect(profile?.picture).toEqual(picture);
    expect(profile?.createdAt).toBe(1000);
    expect(profile?.updatedAt).toBe(2000);
  });

  test('deleting the account forgets it', async () => {
    await forgetProfile(ACCOUNT);
    await expect(getProfile()).resolves.toBeNull();
  });
});
