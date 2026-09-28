jest.mock('@react-native-firebase/analytics', () => ({
  getAnalytics: jest.fn(() => ({})),
  logScreenView: jest.fn().mockResolvedValue(undefined),
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { logEvent as rnfbLogEvent, logScreenView as rnfbLogScreenView } from '@react-native-firebase/analytics';

import { logEvent, logScreenView } from '@/core/services/analytics';

describe('logScreenView', () => {
  test('logs the screen name and class', async () => {
    await logScreenView('/post/[id]');

    expect(rnfbLogScreenView).toHaveBeenCalledWith(expect.anything(), {
      screen_name: '/post/[id]',
      screen_class: '/post/[id]',
    });
  });

  test('swallows a thrown error instead of throwing', async () => {
    (rnfbLogScreenView as jest.Mock).mockRejectedValueOnce(new Error('native module missing'));

    await expect(logScreenView('/post/[id]')).resolves.toBeUndefined();
  });
});

describe('logEvent', () => {
  test('logs the event name', async () => {
    await logEvent('post_created');

    expect(rnfbLogEvent).toHaveBeenCalledWith(expect.anything(), 'post_created');
  });

  test('swallows a thrown error instead of throwing', async () => {
    (rnfbLogEvent as jest.Mock).mockRejectedValueOnce(new Error('native module missing'));

    await expect(logEvent('post_created')).resolves.toBeUndefined();
  });
});
