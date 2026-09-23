jest.mock('@/features/account/services/account-relay');
jest.mock('@/features/dev/dev-reset', () => ({ resetLocalDataForTesting: jest.fn() }));

import { deleteAccount as deleteAccountOnRelay } from '@/features/account/services/account-relay';
import { deleteAccount } from '@/features/account/usecases/delete-account';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';

beforeEach(() => {
  jest.clearAllMocks();
});

test('erases the relay account, then wipes local state', async () => {
  const order: string[] = [];
  (deleteAccountOnRelay as jest.Mock).mockImplementation(async () => {
    order.push('relay');
  });
  (resetLocalDataForTesting as jest.Mock).mockImplementation(async () => {
    order.push('local');
  });

  await deleteAccount();

  expect(order).toEqual(['relay', 'local']);
});

// A relay failure must not wipe local data — there would be nothing left
// to retry the deletion with, and the account would still exist.
test('a relay failure leaves local data alone', async () => {
  (deleteAccountOnRelay as jest.Mock).mockRejectedValue(new Error('offline'));

  await expect(deleteAccount()).rejects.toThrow('offline');
  expect(resetLocalDataForTesting).not.toHaveBeenCalled();
});
