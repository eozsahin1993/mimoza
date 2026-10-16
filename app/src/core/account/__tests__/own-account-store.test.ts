import { initDatabase, resetAllLocalData, saveLocalAccount, storeProfilePicture } from '@/data/db';
import { getOwnAccount, loadOwnAccount, resetOwnAccountStore, setOwnAccount, useOwnAccountStore } from '@/core/account/own-account-store';
import { getPhotoStoreState, resetPhotoStore } from '@/core/photo/photo-store';

const NOW = 1_700_000_000_000;

beforeAll(() => initDatabase());

beforeEach(async () => {
  await resetAllLocalData();
  resetOwnAccountStore();
  resetPhotoStore();
});

test('before any read, there is no account and it is not yet loaded — not the same as signed out', () => {
  expect(useOwnAccountStore.getState()).toEqual({ account: null, loaded: false });
});

test('a device with no local account loads as signed out', async () => {
  await loadOwnAccount();

  expect(useOwnAccountStore.getState()).toEqual({ account: null, loaded: true });
});

test('loads the local account, and seeds its picture into the photo store', async () => {
  await saveLocalAccount({ accountId: 'me', name: 'Emre', deviceId: 'phone', createdAt: NOW, updatedAt: NOW });
  await storeProfilePicture('me', 'pic-1', new Uint8Array([1, 2, 3]));

  await loadOwnAccount();

  expect(getOwnAccount()).toEqual({ accountId: 'me', name: 'Emre' });
  expect(getPhotoStoreState().profilePictures.me).toEqual(expect.any(String));
});

test('a concurrent read is one read, not two', async () => {
  await saveLocalAccount({ accountId: 'me', name: 'Emre', deviceId: 'phone', createdAt: NOW, updatedAt: NOW });

  const first = loadOwnAccount();
  const second = loadOwnAccount();

  expect(second).toBe(first);
  await first;
});

test('sign-in and profile setup write straight in, so nothing waits on a re-read', () => {
  setOwnAccount({ accountId: 'me', name: 'Emre' });

  expect(useOwnAccountStore.getState()).toEqual({ account: { accountId: 'me', name: 'Emre' }, loaded: true });
});
