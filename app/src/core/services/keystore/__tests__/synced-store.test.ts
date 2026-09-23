const mockGetSynced = jest.fn();

jest.mock('../../../../../modules/synced-keystore', () => ({
  __esModule: true,
  default: {
    getSynced: (...args: unknown[]) => mockGetSynced(...args),
    setSynced: jest.fn(),
    deleteSynced: jest.fn(),
  },
}));

import { getSyncedSecret } from '@/core/services/keystore/synced-store';

beforeEach(() => {
  jest.useFakeTimers();
  mockGetSynced.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('getSyncedSecret retry', () => {
  test('returns immediately when the first read finds something', async () => {
    mockGetSynced.mockResolvedValue('found');

    await expect(getSyncedSecret('k')).resolves.toBe('found');
    expect(mockGetSynced).toHaveBeenCalledTimes(1);
  });

  test('retries past early misses and returns a later hit', async () => {
    mockGetSynced.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce('found');

    const promise = getSyncedSecret('k');
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBe('found');
    expect(mockGetSynced).toHaveBeenCalledTimes(3);
  });

  test('gives up after the last retry and reports absence, not an early guess', async () => {
    mockGetSynced.mockResolvedValue(null);

    const promise = getSyncedSecret('k');
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
    expect(mockGetSynced).toHaveBeenCalledTimes(4); // 3 retries plus the final read
  });
});
