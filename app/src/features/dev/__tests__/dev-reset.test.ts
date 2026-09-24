jest.mock('@/data/db', () => ({
  getAllCircleIds: jest.fn(async () => ['c1', 'c2']),
  getProfile: jest.fn(async () => ({ accountId: 'acc-1', name: 'Ali', deviceId: 'phone', createdAt: 0, updatedAt: 0 })),
  resetAllLocalData: jest.fn(async () => undefined),
  resetDatabaseSchema: jest.fn(async () => undefined),
}));
jest.mock('@/ui/theme/hooks/use-own-color-seed', () => ({ clearOwnColorSeedCache: jest.fn() }));
jest.mock('@/core/services/keystore/circle-keys', () => ({ deleteCircleKeys: jest.fn(async () => undefined) }));
jest.mock('@/core/services/keystore/account-keypair', () => ({ forgetAccountKeypair: jest.fn(async () => undefined) }));
jest.mock('@/core/services/keystore/auth-token', () => ({ deleteAuthToken: jest.fn(async () => undefined) }));
jest.mock('@/core/photo/photo-cache', () => ({ deleteCirclePhotoFiles: jest.fn() }));

import { getAllCircleIds, getProfile } from '@/data/db';
import { forgetAccountKeypair } from '@/core/services/keystore/account-keypair';
import { deleteCirclePhotoFiles } from '@/core/photo/photo-cache';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';

beforeEach(() => jest.clearAllMocks());

describe('resetLocalDataForTesting', () => {
  // purge-circle.ts's own doc comment says this function's job, on
  // account erasure, includes "the decrypted photo files" — but nothing
  // wired it in, so a deleted account's photos were left readable in the
  // cache directory after every row referencing them was gone.
  test('drops every circle\'s decrypted photo cache, not just its keys and rows', async () => {
    await resetLocalDataForTesting();

    expect(deleteCirclePhotoFiles).toHaveBeenCalledWith('c1');
    expect(deleteCirclePhotoFiles).toHaveBeenCalledWith('c2');
  });

  test('forgets the signed-in account\'s keypair, read before the profile row is wiped', async () => {
    await resetLocalDataForTesting();

    expect(forgetAccountKeypair).toHaveBeenCalledWith('acc-1');
  });

  test('with no local profile yet, there is nothing to forget', async () => {
    (getProfile as jest.Mock).mockResolvedValue(null);

    await resetLocalDataForTesting();

    expect(forgetAccountKeypair).not.toHaveBeenCalled();
  });

  test('with no circles, nothing is purged', async () => {
    (getAllCircleIds as jest.Mock).mockResolvedValue([]);

    await resetLocalDataForTesting();

    expect(deleteCirclePhotoFiles).not.toHaveBeenCalled();
  });
});
