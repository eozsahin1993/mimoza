jest.mock('@react-native-firebase/crashlytics', () => ({
  getCrashlytics: jest.fn(() => ({})),
  log: jest.fn(),
  recordError: jest.fn().mockResolvedValue(undefined),
}));

import { getCrashlytics, log, recordError as rnfbRecordError } from '@react-native-firebase/crashlytics';

import { initCrashReporting, recordError } from '@/core/services/crash-reporting';

describe('initCrashReporting', () => {
  test('constructs the Crashlytics module', () => {
    initCrashReporting();

    expect(getCrashlytics).toHaveBeenCalled();
  });

  test('does not throw when the native module is unavailable', () => {
    (getCrashlytics as jest.Mock).mockImplementationOnce(() => {
      throw new Error('native module missing');
    });

    expect(() => initCrashReporting()).not.toThrow();
  });
});

describe('recordError', () => {
  test('records an Error as-is', async () => {
    const error = new Error('boom');

    await recordError(error);

    expect(rnfbRecordError).toHaveBeenCalledWith(expect.anything(), error);
  });

  test('wraps a non-Error value in an Error', async () => {
    await recordError('boom');

    expect(rnfbRecordError).toHaveBeenCalledWith(expect.anything(), expect.any(Error));
  });

  test('logs the context first when given one', async () => {
    await recordError(new Error('boom'), 'while draining the outbox');

    expect(log).toHaveBeenCalledWith(expect.anything(), 'while draining the outbox');
  });

  test('swallows a thrown error instead of throwing', async () => {
    (rnfbRecordError as jest.Mock).mockRejectedValueOnce(new Error('native module missing'));

    await expect(recordError(new Error('boom'))).resolves.toBeUndefined();
  });
});
