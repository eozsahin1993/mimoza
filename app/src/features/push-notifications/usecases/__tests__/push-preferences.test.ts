jest.mock('@/features/push-notifications/services/notify-level-relay');

import { setNotifyLevel } from '@/features/push-notifications/services/notify-level-relay';
import { setCircleNotifyLevel } from '@/features/push-notifications/usecases/push-preferences';

beforeEach(() => {
  jest.clearAllMocks();
});

test('sets the caller-own row through the relay', async () => {
  (setNotifyLevel as jest.Mock).mockResolvedValue(undefined);

  await setCircleNotifyLevel('circle-1', 'account-1', 'comments');

  expect(setNotifyLevel).toHaveBeenCalledWith('circle-1', 'account-1', 'comments');
});

test('a failed relay call surfaces rather than being swallowed', async () => {
  (setNotifyLevel as jest.Mock).mockRejectedValue(new Error('offline'));

  await expect(setCircleNotifyLevel('circle-1', 'account-1', 'none')).rejects.toThrow('offline');
});
